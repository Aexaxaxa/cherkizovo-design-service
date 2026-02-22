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

## Snapshot assets export on sync

`POST /api/admin/sync` now auto-exports PNG assets from Figma for visible nodes named (case-insensitive):
- `logo`
- `logo_bg`
- `sticker`
- `marks`

Saved keys format in B2:
- `snapshots/<FIGMA_FILE_KEY>/assets/<safeNodeId>.png`

Each frame snapshot `frames/<safeFrameId>.json` stores `assetsMap[nodeId] = assetKey`, and runtime renders these assets from B2 without Figma calls.

## Runtime manual assets (sticker/marks)

If a node name is `sticker` or `marks`, runtime also tries B2 keys by `safeFrameId = templateId.replaceAll(":", "_")`:
- `assets/manual-assets/<safeFrameId>__sticker.png`
- `assets/manual-assets/<safeFrameId>__marks.png`
- fallback: `assets/manual-assets/<safeFrameId>.png`

If object is missing, the layer is skipped (no runtime error).

## Sync note (assets)

After these changes you must run `POST /api/admin/sync` again.
Assets are exported with kind suffixes:
- `snapshots/<FIGMA_FILE_KEY>/assets/<safeNodeId>__logo.png`
- `snapshots/<FIGMA_FILE_KEY>/assets/<safeNodeId>__logo_bg.png`
- `snapshots/<FIGMA_FILE_KEY>/assets/<safeNodeId>__sticker.png`
- `snapshots/<FIGMA_FILE_KEY>/assets/<safeNodeId>__marks.png`
