Vico Pay startup migration correction

Replace only the matching files in your existing vicopay-website folder with these files. Do not replace the entire project.

Corrections:
1. Removed the invalid fans.migrate() startup call. fans.js is a live-hook factory and does not export migrate(). Fan hooks remain in server.js.
2. Standardized the dedicated PostgreSQL session advisory locks used by startup schema migrations to one shared key (727200). This serializes concurrent schema migrations and prevents the lock-order deadlock shown in the Render logs.

Files included are only the changed server/migration files. No .env, node_modules, credentials, or database data are included.

After replacing files, commit and push them. In Render, ensure only one active web-service instance is running during the first deployment. Do not delete or reset your Neon database.

The pg-connection-string SSL mode message is a warning, not the cause of the startup exit.
