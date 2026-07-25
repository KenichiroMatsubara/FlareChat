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

ローカルの Control D1 は軽量なローカル DB ブラウザで確認できます。先にマイグレーションを適用してから起動してください。起動するとブラウザも自動で開きます。

```bash
npm run db:local
npm run db:studio
```

本来の Drizzle Studio を使う場合は `npm run db:drizzle` です。こちらは `local.drizzle.studio` の大きな UI を読み込むため、初回表示に時間がかかることがあります。

Organization D1 など別の SQLite ファイルを開く場合は、`DB_STUDIO_PATH` にファイルパスを指定します。ローカル DB ブラウザを自動起動したくない場合は `DB_BROWSER_NO_OPEN=1` を指定してください。

Google OAuthやLINE Messaging APIの値は `apps/worker/.dev.vars.example` を
`apps/worker/.dev.vars` にコピーして設定します。

Google OAuth の承認済みリダイレクト URI には
`http://localhost:8787/oauth/google/login/callback` を登録してください。初回画面は
Google ログインだけです。同意後、受信した新着メールに `2026/08/03 19:00-21:00` または
`2026年8月3日 19:00〜21:00` のような日付と時刻範囲があれば、primary Calendar に予定を
作成します。ログイン時点より前のメールは処理しません。
