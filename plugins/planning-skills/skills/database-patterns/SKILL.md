---
name: Database Patterns
description: Use when analyzing database usage patterns. Covers N+1 queries, missing indexes, connection pooling, migration safety, and data integrity anti-patterns.
user-invocable: false
---

# Database Patterns Checklist

When investigating database usage in a codebase, check for these patterns. Report specific file paths, line numbers, and code — not generic advice.

## N+1 Query Problems

- Loops that execute a query per iteration instead of batching
- ORM relations loaded lazily inside loops (e.g., `for (const user of users) { await user.posts() }`)
- GraphQL resolvers that fetch related data per-item instead of using DataLoader
- API endpoints that make multiple sequential DB calls for list responses

**What to look for:** Database calls inside `for`/`forEach`/`map` loops, ORM `.find()` calls inside iteration, missing `include`/`with`/`join` clauses on list queries.

## Missing Indexes

- Columns used in WHERE clauses without indexes
- Foreign key columns without indexes (slow JOINs)
- Columns used in ORDER BY without indexes
- Composite queries that would benefit from compound indexes
- Text search without full-text indexes

**What to look for:** Migration files that add columns referenced in queries but don't add indexes, queries filtering on unindexed columns, slow query patterns in ORM usage.

## Connection Pooling

- Creating new database connections per request instead of using a pool
- Missing connection pool configuration (max connections, idle timeout)
- Connection leaks (connections opened but never closed/returned to pool)
- Missing connection error handling and reconnection logic

**What to look for:** `new Client()` or `createConnection()` inside request handlers, missing `pool` configuration in database setup, missing `.release()` or `.end()` calls.

## Migration Safety

- Destructive migrations without rollback plans (dropping columns/tables)
- Long-running migrations that lock tables (adding indexes without CONCURRENTLY)
- Data migrations mixed with schema migrations
- Missing migration for schema changes (manual DB modifications)
- Migrations that assume specific data state

**What to look for:** `DROP COLUMN`, `DROP TABLE` without corresponding up/down migrations, `CREATE INDEX` without `CONCURRENTLY`, `ALTER TABLE` on large tables without considering lock duration.

## Data Integrity

- Missing foreign key constraints (orphaned records possible)
- Missing NOT NULL constraints on required fields
- Missing unique constraints on business-unique fields (email, username)
- Missing CHECK constraints on bounded values
- Soft deletes without proper cascade handling
- Missing transaction boundaries around multi-step operations

**What to look for:** Schema definitions without foreign keys, nullable columns that should be required, missing `UNIQUE` constraints, multi-table updates outside transactions.

## Query Safety

- Raw SQL with string interpolation (SQL injection risk)
- Missing pagination on list queries (unbounded result sets)
- SELECT * instead of selecting needed columns
- Missing query timeouts (long-running queries can exhaust connections)
- Unparameterized queries in ORMs

**What to look for:** Template literals in SQL strings, queries without `LIMIT`, `SELECT *` in production code, missing `statement_timeout` or query timeout configuration.

## ORM Anti-Patterns

- Over-fetching: loading full records when only IDs or specific fields are needed
- Under-using transactions: related operations that should be atomic but aren't
- Ignoring ORM query logging in development (can't see N+1 issues)
- Raw queries that bypass ORM validation and type safety

**What to look for:** ORM queries that load all columns when only a few are needed, sequential `.save()` calls that should be in a transaction, disabled query logging.

## Reporting Guidelines

For each finding:
1. Specify the exact file path and line number(s)
2. Quote the problematic code
3. Estimate performance impact (e.g., "N+1: 100 users = 101 queries instead of 2")
4. Suggest a specific fix with code example
