import type { NextFunction, Request, Response } from 'express'
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
  PrismaClientRustPanicError,
  PrismaClientUnknownRequestError,
  PrismaClientValidationError,
} from '@prisma/client/runtime/library'
import { ZodError } from 'zod'

const MODEL_LABELS: Record<string, string> = {
  User: 'user',
  ConnectedAccount: 'connected account',
  ProviderConfig: 'Google OAuth configuration',
  File: 'file',
  Folder: 'folder',
  FileShare: 'share link',
  Invite: 'invite',
  UploadSession: 'upload session',
  OauthState: 'OAuth state',
  AuthHandoff: 'auth handoff',
  StorageAccount: 'storage account',
  S3StorageConfig: 'S3 storage configuration',
  AuditLog: 'audit log',
}

function labelForModel(modelName: unknown): string {
  if (typeof modelName === 'string' && MODEL_LABELS[modelName]) return MODEL_LABELS[modelName]
  if (typeof modelName === 'string' && modelName) return modelName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return 'record'
}

function send(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ code, message })
}

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const message = issue?.message || 'Invalid request data.'
    return send(res, 400, 'VALIDATION_ERROR', message)
  }

  if (error instanceof PrismaClientKnownRequestError) {
    const model = labelForModel(error.meta?.modelName)

    switch (error.code) {
      case 'P2025':
        return send(res, 404, 'NOT_FOUND', `The requested ${model} was not found.`)
      case 'P2002': {
        const target = Array.isArray(error.meta?.target) ? error.meta.target.join(', ') : (typeof error.meta?.target === 'string' ? error.meta.target : '')
        const message = target
          ? `A ${model} with this ${target} already exists.`
          : `A ${model} with these values already exists.`
        return send(res, 409, 'CONFLICT', message)
      }
      case 'P2003':
        return send(res, 400, 'INVALID_REFERENCE', 'A referenced record does not exist.')
      case 'P2014':
        return send(res, 400, 'RELATION_VIOLATION', 'This change would violate a required relation.')
      case 'P2021':
      case 'P2022':
        return send(res, 500, 'DATABASE_SCHEMA_ERROR', 'Database schema is out of date.')
      default:
        return send(res, 400, 'DATABASE_ERROR', 'A database operation could not be completed.')
    }
  }

  if (error instanceof PrismaClientValidationError) {
    return send(res, 400, 'VALIDATION_ERROR', 'Invalid request parameters.')
  }

  if (error instanceof PrismaClientInitializationError) {
    return send(res, 503, 'DATABASE_UNAVAILABLE', 'Database is currently unavailable. Please try again later.')
  }

  if (error instanceof PrismaClientUnknownRequestError || error instanceof PrismaClientRustPanicError) {
    return send(res, 500, 'DATABASE_ERROR', 'A database error occurred. Please try again.')
  }

  if (error instanceof Error) {
    const message = /prisma\.|invocation in/i.test(error.message)
      ? 'A database error occurred. Please try again.'
      : error.message
    return send(res, 500, 'INTERNAL_SERVER_ERROR', message || 'Internal server error')
  }

  return send(res, 500, 'INTERNAL_SERVER_ERROR', 'Internal server error')
}
