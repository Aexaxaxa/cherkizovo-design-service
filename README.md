# cherkizovo-design-service

## Запуск локально

1. Установить зависимости:
   ```bash
   pnpm install
   ```
2. Создать `.env.local` по примеру `.env.example` и заполнить:
   - `FIGMA_TOKEN`
   - `FIGMA_FILE_KEY`
   - `B2_BUCKET_NAME`
   - `B2_S3_REGION`
   - `B2_S3_ENDPOINT`
   - `B2_ACCESS_KEY_ID`
   - `B2_SECRET_ACCESS_KEY`
   - `MAX_UPLOAD_MB` (опционально, default `10`)
   - `SIGNED_URL_EXPIRES_SEC` (опционально, default `900`)
3. Запустить dev:
   ```bash
   pnpm dev
   ```

## API

- `GET /api/health`
- `GET /api/templates`
- `POST /api/upload` (`multipart/form-data`, поле `file`)
- `POST /api/generate` (`application/json`)
