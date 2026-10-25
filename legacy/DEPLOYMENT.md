# Deployment notes

## Environments

Keep local, staging and production credentials separate. Configure the database, signing keys, Mistral key, allowed origins, email provider and object storage through the deployment secret manager. Never commit `.env` files or expose server credentials through a `VITE_` variable.

## Production shape

- Serve the compiled web application through a CDN or static host with HTTPS.
- Run the versioned API as a stateless service behind TLS termination and rate limiting.
- Use managed PostgreSQL with automated backups, point-in-time recovery and private networking.
- Run scheduled/background work in a separate worker process from the same modular codebase.
- Put uploads in private object storage and serve short-lived signed download links.
- Send structured logs, errors, request IDs, health checks and database metrics to monitoring.

## Release sequence

1. Provision database and application secrets.
2. Apply reviewed migrations using a one-shot release job.
3. Deploy API and worker; verify readiness and migration version.
4. Deploy the static client and configure the API origin.
5. Verify login, tenant membership, health endpoint, backup status and audit writes.

Use backward-compatible expand/migrate/contract schema changes. Do not run seed data in production. Demo credentials and seed fixtures belong only in isolated development environments. The included API currently uses a single-node SQLite adapter; switch the API persistence layer and migration runner to PostgreSQL before deploying a multi-instance SaaS service.
