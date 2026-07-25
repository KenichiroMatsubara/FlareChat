# Mail Automation

Gmailで受信した案内を自動で予定へ変換し、Google Calendar、メール、LINEへ配信するCloudflareネイティブの管理サービスです。

## 構成

- Hono + Cloudflare Workers
- D1（Control DB + Organization DB）
- Cloudflare Cron / Queues
- R2
- React + Viteの専用管理GUI

## ローカル起動

```bash
npm install
npm run db:local
npm run dev
```

GUIは `http://localhost:5173`、APIは `http://localhost:8787` で起動します。

Google OAuthやLINE Messaging APIの値は `apps/worker/.dev.vars.example` を
`apps/worker/.dev.vars` にコピーして設定します。
