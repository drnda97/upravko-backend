# Upravko API

Uputstvo: [../README.md](../README.md). Odluke: [../DECISIONS.md](../DECISIONS.md).

- `migrations/`: SQL šema (`npm run migrate`)
- `seed/seed.ts`: test podaci (`npm run seed`, `npm run seed:reset`)
- `src/routes/`: rute `/api/v1`
- `src/lib/access.ts`: dozvole
- `src/jobs/`: glasanja, mesečna zaduženja, podsetnici
- `test/`: `npm test` (baza `upravko_test`)

Uživo: Socket.IO, `auth: { token }`, pa `emit('building:join', buildingId)`; server šalje `change` sa `{ event, id }`.

Produkcija: `NODE_ENV=production`, svoj `JWT_SECRET`, prazan `DEMO_NOW`, `CORS_ORIGINS`, `SMTP_URL`, `PUBLIC_URL`.
