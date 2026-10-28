# Combo LKGP Toggle — Implementasi

## Latar Belakang
DB combo (`handleComboChat`) saat ini static ordered fallback — tidak ada memory "model X tadi gagal." Request tetap nembak member pertama (mis. `oc/deepseek`) meskipun gagal berulang kali. Auto virtual pool punya LKGP + cooldown + probe; kita ingin fitur serupa tapi **per-combo toggle**.

## Design

### Storage
- Scope: `comboState` (tabela `kv` yang sudah ada)
- Key: `lkgp:<comboName>` → `{ model: "alias/model", updatedAt: ts }`
- Reuse `makeKv` helper yang sama seperti `autoComboState`

### Toggle
- `comboStrategies.<comboName>.lkgpEnabled` (boolean, default false)
- Di-`GET /api/settings`, dan di dashboard UI combo (checkbox)
- Hanya model konkret (`alias/model`) yang dipromosikan — **bukan** `auto`/`smart` (punya LKGP internal)

### `handleComboChat` flow (saat enabled)
1. Load combo LKGP → reorder ke depan (hanya jika ada & masih di list)
2. Success → `noteComboSuccess(model)` → promote ke LKGP
3. All-fail → `clearComboLkgp()` → kembali urutan asli next request
4. Tiada cooldown/probe — jika LKGP model gagal, langsung fallback ke urutan berikutnya (natural)

### Files
1. `src/lib/db/repos/comboLkgpRepo.js` — get/set/clear/promote (scope `comboState`)
2. `src/lib/db/index.js` — export baru
3. `src/lib/localDb.js` — re-export
4. `open-sse/services/combo.js` `handleComboChat` — terima deps `{comboLkgp, noteComboSuccess, noteComboFailure, clearComboLkgps}`
5. `src/sse/handlers/chat.js` ×2 call sites — load LKGP + pass callback
6. `src/app/api/settings/route.js` — tidak perlu change (comboStrategies udah supported)
7. `tests/unit/combo-lkgp.test.js`

## Verifikasi
- Unit test: `combo-lkgp.test.js`
- Live: `GET /api/combos` → lihat `hemer-mac`, set `comboStrategies.hemer-mac.lkgpEnabled: true`, test request → log `▶ POST hemer-mac → <lkgp model>`
