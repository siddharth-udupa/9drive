import { Prisma, PrismaClient } from '@prisma/client'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { normalizeEmail } from '../utils/email.js'

dotenv.config()

type Row = Record<string, any>

const requiredTables = [
  'users',
  'user_sessions',
  'provider_configs',
  'oauth_states',
  'connected_accounts',
  's3_storage_configs',
  'storage_accounts',
  'folders',
  'files',
  'file_shares',
  'file_preview_tokens',
  'upload_sessions',
  'workspace_invites',
  'api_keys',
  'upload_routing_policies',
  'auth_handoffs',
  'audit_logs',
] as const

type TableName = (typeof requiredTables)[number]

const prisma = new PrismaClient()

function connectionOptions(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!database) throw new Error('MYSQL_DATABASE_URL must include a database name.')
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  throw new Error(`Cannot convert ${String(value)} to a date.`)
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value)
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.length > 0) return BigInt(value)
  throw new Error(`Cannot convert ${String(value)} to a bigint.`)
}

function toBigIntOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : toBigInt(value)
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function toJsonArray(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
  }
  return []
}

function toNullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Prisma.InputJsonValue
    } catch {
      return raw
    }
  }
  return raw as Prisma.InputJsonValue
}

function duplicateKeys(rows: Row[], key: (row: Row) => string, label: string) {
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const row of rows) {
    const value = key(row)
    if (seen.has(value)) duplicates.push(`${seen.get(value)} and ${row.id} both normalize to ${value}`)
    else seen.set(value, row.id)
  }
  if (duplicates.length > 0) {
    throw new Error(`Cannot safely normalize ${label}; resolve these duplicates first:\n${duplicates.join('\n')}`)
  }
}

async function readTable(connection: mysql.Connection, table: TableName): Promise<Row[]> {
  const [rows] = await connection.query(`SELECT * FROM \`${table}\``)
  return rows as Row[]
}

async function insertChunks(delegate: { createMany(args: any): Promise<any> }, rows: Row[]) {
  const chunkSize = 500
  for (let index = 0; index < rows.length; index += chunkSize) {
    await delegate.createMany({ data: rows.slice(index, index + chunkSize) })
  }
}

async function assertTargetIsEmpty() {
  const counts: Array<[TableName, number]> = []
  counts.push(['users', await prisma.user.count()])
  counts.push(['user_sessions', await prisma.userSession.count()])
  counts.push(['provider_configs', await prisma.providerConfig.count()])
  counts.push(['oauth_states', await prisma.oauthState.count()])
  counts.push(['connected_accounts', await prisma.connectedAccount.count()])
  counts.push(['s3_storage_configs', await prisma.s3StorageConfig.count()])
  counts.push(['storage_accounts', await prisma.storageAccount.count()])
  counts.push(['folders', await prisma.folder.count()])
  counts.push(['files', await prisma.file.count()])
  counts.push(['file_shares', await prisma.fileShare.count()])
  counts.push(['file_preview_tokens', await prisma.filePreviewToken.count()])
  counts.push(['upload_sessions', await prisma.uploadSession.count()])
  counts.push(['workspace_invites', await prisma.workspaceInvite.count()])
  counts.push(['api_keys', await prisma.apiKey.count()])
  counts.push(['upload_routing_policies', await prisma.uploadRoutingPolicy.count()])
  counts.push(['auth_handoffs', await prisma.authHandoff.count()])
  counts.push(['audit_logs', await prisma.auditLog.count()])
  const nonEmpty = counts.filter(([, count]) => count > 0)
  if (nonEmpty.length > 0) {
    throw new Error(`Target PostgreSQL database is not empty (${nonEmpty.map(([name, count]) => `${name}=${count}`).join(', ')}). Re-run with --force only if you intend to erase it.`)
  }
}

async function truncateTarget() {
  const tables = requiredTables.map((name) => `"${name}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`)
}

async function main() {
  const sourceUrl = process.env.MYSQL_DATABASE_URL
  const targetUrl = process.env.DATABASE_URL
  if (!sourceUrl) throw new Error('MYSQL_DATABASE_URL is required (the old MySQL connection string).')
  if (!targetUrl) throw new Error('DATABASE_URL is required (the new PostgreSQL connection string).')
  if (!/^postgres(ql)?:\/\//.test(targetUrl)) throw new Error('DATABASE_URL must be a PostgreSQL connection string.')

  const force = process.argv.includes('--force')

  const connection = await mysql.createConnection(connectionOptions(sourceUrl))
  try {
    const source = Object.fromEntries(await Promise.all(
      requiredTables.map(async (table) => [table, await readTable(connection, table)]),
    )) as Record<TableName, Row[]>

    duplicateKeys(source.users, (row) => normalizeEmail(row.email), 'user emails')
    duplicateKeys(
      source.workspace_invites,
      (row) => `${row.inviter_id}|${normalizeEmail(row.invitee_email)}|${row.target_type}|${row.target_id}`,
      'workspace invite emails',
    )

    if (force) {
      console.warn('--force supplied: the target PostgreSQL tables will be truncated before import.')
      await truncateTarget()
    } else {
      await assertTargetIsEmpty()
    }

    for (const table of requiredTables) {
      console.log(`Read ${source[table].length} rows from MySQL ${table}`)
    }

    await prisma.$transaction(async (tx) => {
      await insertChunks(tx.user, source.users.map((row) => ({
        id: row.id,
        name: row.name,
        email: normalizeEmail(row.email),
        passwordHash: row.password_hash,
        status: row.status,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.userSession, source.user_sessions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        refreshTokenHash: row.refresh_token_hash,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        expiresAt: toDate(row.expires_at),
        revokedAt: toDateOrNull(row.revoked_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.providerConfig, source.provider_configs.map((row) => ({
        id: row.id,
        userId: row.user_id,
        provider: row.provider,
        clientIdEncrypted: row.client_id_encrypted,
        clientSecretEncrypted: row.client_secret_encrypted,
        redirectUri: row.redirect_uri,
        scopes: toJsonArray(row.scopes),
        status: row.status,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.oauthState, source.oauth_states.map((row) => ({
        id: row.id,
        userId: row.user_id,
        providerConfigId: row.provider_config_id,
        flow: row.flow,
        stateHash: row.state_hash,
        expiresAt: toDate(row.expires_at),
        usedAt: toDateOrNull(row.used_at),
        createdAt: toDate(row.created_at),
      })))

      await insertChunks(tx.connectedAccount, source.connected_accounts.map((row) => ({
        id: row.id,
        userId: row.user_id,
        providerConfigId: row.provider_config_id,
        provider: row.provider,
        providerAccountId: row.provider_account_id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        accessTokenEncrypted: row.access_token_encrypted,
        refreshTokenEncrypted: row.refresh_token_encrypted,
        tokenExpiresAt: toDateOrNull(row.token_expires_at),
        scopes: toJsonArray(row.scopes),
        status: row.status,
        lastError: row.last_error,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.s3StorageConfig, source.s3_storage_configs.map((row) => ({
        id: row.id,
        userId: row.user_id,
        connectedAccountId: row.connected_account_id,
        name: row.name,
        bucket: row.bucket,
        region: row.region,
        endpoint: row.endpoint,
        accessKeyIdEncrypted: row.access_key_id_encrypted,
        secretAccessKeyEncrypted: row.secret_access_key_encrypted,
        forcePathStyle: toBoolean(row.force_path_style),
        prefix: row.prefix,
        quotaBytes: toBigIntOrNull(row.quota_bytes),
        status: row.status,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.storageAccount, source.storage_accounts.map((row) => ({
        id: row.id,
        connectedAccountId: row.connected_account_id,
        totalBytes: toBigIntOrNull(row.total_bytes),
        usedBytes: toBigInt(row.used_bytes),
        availableBytes: toBigIntOrNull(row.available_bytes),
        trashBytes: toBigIntOrNull(row.trash_bytes),
        lastSyncedAt: toDateOrNull(row.last_synced_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      // Insert folders without parents first, then restore parent_id with raw SQL so
      // the original updated_at value is not changed by Prisma's @updatedAt behavior.
      await insertChunks(tx.folder, source.folders.map((row) => ({
        id: row.id,
        userId: row.user_id,
        parentId: null,
        connectedAccountId: row.connected_account_id,
        provider: row.provider,
        providerFolderId: row.provider_folder_id,
        name: row.name,
        color: row.color,
        iconUrl: row.icon_url,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
        deletedAt: toDateOrNull(row.deleted_at),
      })))
      for (const row of source.folders) {
        if (row.parent_id) {
          await tx.$executeRaw`UPDATE "folders" SET "parent_id" = ${row.parent_id} WHERE "id" = ${row.id}`
        }
      }

      await insertChunks(tx.file, source.files.map((row) => ({
        id: row.id,
        userId: row.user_id,
        connectedAccountId: row.connected_account_id,
        folderId: row.folder_id,
        provider: row.provider,
        providerFileId: row.provider_file_id,
        name: row.name,
        mimeType: row.mime_type,
        sizeBytes: toBigInt(row.size_bytes),
        checksum: row.checksum,
        status: row.status,
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
        deletedAt: toDateOrNull(row.deleted_at),
      })))

      await insertChunks(tx.fileShare, source.file_shares.map((row) => ({
        id: row.id,
        fileId: row.file_id,
        userId: row.user_id,
        token: row.token,
        tokenHash: row.token_hash,
        enabled: toBoolean(row.enabled),
        expiresAt: toDateOrNull(row.expires_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.filePreviewToken, source.file_preview_tokens.map((row) => ({
        id: row.id,
        fileId: row.file_id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: toDate(row.expires_at),
        createdAt: toDate(row.created_at),
      })))

      await insertChunks(tx.uploadSession, source.upload_sessions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        targetConnectedAccountId: row.target_connected_account_id,
        folderId: row.folder_id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: toBigInt(row.size_bytes),
        status: row.status,
        googleSessionUri: row.google_session_uri,
        errorMessage: row.error_message,
        createdAt: toDate(row.created_at),
        completedAt: toDateOrNull(row.completed_at),
      })))

      await insertChunks(tx.workspaceInvite, source.workspace_invites.map((row) => ({
        id: row.id,
        inviterId: row.inviter_id,
        inviteeEmail: normalizeEmail(row.invitee_email),
        targetType: row.target_type,
        targetId: row.target_id,
        role: row.role,
        status: row.status,
        revokedAt: toDateOrNull(row.revoked_at),
        acceptedAt: toDateOrNull(row.accepted_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.apiKey, source.api_keys.map((row) => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        keyPrefix: row.key_prefix,
        keyHash: row.key_hash,
        scopes: toJsonArray(row.scopes),
        status: row.status,
        lastUsedAt: toDateOrNull(row.last_used_at),
        expiresAt: toDateOrNull(row.expires_at),
        revokedAt: toDateOrNull(row.revoked_at),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.uploadRoutingPolicy, source.upload_routing_policies.map((row) => ({
        id: row.id,
        userId: row.user_id,
        mode: row.mode,
        priorityAccountIds: toJsonArray(row.priority_account_ids),
        roundRobinCursor: Number(row.round_robin_cursor),
        createdAt: toDate(row.created_at),
        updatedAt: toDate(row.updated_at),
      })))

      await insertChunks(tx.authHandoff, source.auth_handoffs.map((row) => ({
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: toDate(row.expires_at),
        usedAt: toDateOrNull(row.used_at),
        createdAt: toDate(row.created_at),
      })))

      await insertChunks(tx.auditLog, source.audit_logs.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        metadata: toNullableJson(row.metadata),
        createdAt: toDate(row.created_at),
      })))
    }, { maxWait: 10_000, timeout: 30 * 60_000 })

    const targetCounts: Record<TableName, () => Promise<number>> = {
      users: () => prisma.user.count(),
      user_sessions: () => prisma.userSession.count(),
      provider_configs: () => prisma.providerConfig.count(),
      oauth_states: () => prisma.oauthState.count(),
      connected_accounts: () => prisma.connectedAccount.count(),
      s3_storage_configs: () => prisma.s3StorageConfig.count(),
      storage_accounts: () => prisma.storageAccount.count(),
      folders: () => prisma.folder.count(),
      files: () => prisma.file.count(),
      file_shares: () => prisma.fileShare.count(),
      file_preview_tokens: () => prisma.filePreviewToken.count(),
      upload_sessions: () => prisma.uploadSession.count(),
      workspace_invites: () => prisma.workspaceInvite.count(),
      api_keys: () => prisma.apiKey.count(),
      upload_routing_policies: () => prisma.uploadRoutingPolicy.count(),
      auth_handoffs: () => prisma.authHandoff.count(),
      audit_logs: () => prisma.auditLog.count(),
    }

    const mismatches: string[] = []
    for (const table of requiredTables) {
      const expected = source[table].length
      const actual = await targetCounts[table]()
      console.log(`Verified ${table}: ${actual}/${expected}`)
      if (actual !== expected) mismatches.push(`${table}: expected ${expected}, got ${actual}`)
    }
    if (mismatches.length > 0) throw new Error(`Row count validation failed:\n${mismatches.join('\n')}`)

    const mixedCase = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM "users" WHERE "email" <> lower("email")) +
        (SELECT COUNT(*) FROM "workspace_invites" WHERE "invitee_email" <> lower("invitee_email"))
      )::bigint AS count
    `
    if (Number(mixedCase[0]?.count ?? 0) !== 0) throw new Error('Email normalization validation failed.')

    console.log('MySQL -> PostgreSQL data migration completed successfully.')
  } finally {
    await connection.end()
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
