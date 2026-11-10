# Legacy MySQL migrations

These migrations are kept only as a reference for the previous MySQL schema.

Prisma cannot replay them against PostgreSQL. The active migration history lives in
`../migrations/`, which starts with the PostgreSQL baseline. To move existing data,
use `npm run migrate:mysql-to-postgres` from `backend/`.
