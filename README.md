# FEVER MJ オンライン対戦サーバー

オリジナル3人麻雀「FEVER MJ」をブラウザからリアルタイム対戦できるオンライン版です。
既存の単独動作版（`../play.html`）を元に、3人がスマホ・PCから合言葉部屋でマッチングして対戦できるようにしていきます。

## 開発フェーズ

| フェーズ | 状態 | 内容 |
|---|---|---|
| 1. MVP（起動骨格） | ✅ いまここ | サーバー起動・静的ファイル配信 |
| 2. ロジック移植 | ⏳ 次 | `game` オブジェクトを `src/game/` に移植 |
| 3. ロビー＋配牌同期 | ⏳ | 合言葉部屋・3人マッチング・配牌 |
| 4. ゲーム完走 | ⏳ | 打牌・鳴き・アガリ判定・全6局 |
| 5. 演出統合 | ⏳ | FEVER・カットイン・チップ移動アニメ |
| 6. 堅牢性 | ⏳ | 切断・再接続・CPU 代打 |
| 7. 戦績＋デプロイ | ⏳ | SQLite・Render 公開 |

詳細は `../FEVER_MJ_対戦型設計書_v1.0.md` を参照してください。

---

## 必要なもの

- **Node.js 20 以上**（このプロジェクトは v24 で開発中）
  - 確認: `node --version`
- **npm**（Node.js に同梱）
  - 確認: `npm --version`

---

## ローカルで動かす手順

### 1. 依存ライブラリのインストール

このフォルダ（`fever-mj-server`）で1回だけ実行：

```bash
npm install
```

`node_modules` というフォルダが作られ、必要なライブラリ（Express、Socket.IO など）がダウンロードされます。

> **メモ**: `better-sqlite3`（戦績記録用）は `optionalDependencies` に入れているので、
> もしビルド失敗の警告が出ても他のライブラリは正常にインストールされます。
> 実際に使うのはフェーズ7なので、今は警告が出ても問題ありません。

### 2. サーバー起動

```bash
npm start
```

以下のように表示されれば成功です：

```
==============================================
  FEVER MJ サーバーが起動しました
  ロビー: http://localhost:3000/
  対局:   http://localhost:3000/play.html
  停止: Ctrl + C
==============================================
```

### 3. ブラウザで確認

- ロビー画面: <http://localhost:3000/>
- 既存の対局画面（CPU 対戦版）: <http://localhost:3000/play.html>

### 4. サーバーを止める

ターミナルで `Ctrl + C` を押します。

---

## 開発中のおすすめコマンド

```bash
# ファイルを変更したら自動で再起動する開発モード
npm run dev
```

`server.js` などを編集して保存すると、自動でサーバーが再起動されます。

---

## プロジェクト構成

```
fever-mj-server/
├── package.json          # 依存ライブラリの定義
├── server.js             # サーバーの入口（このファイルから起動）
├── .env.example          # 環境変数のサンプル（.env を作る時にコピー）
├── .gitignore            # Git に乗せないファイル一覧
├── README.md             # このファイル
│
├── src/                  # サーバー側のロジック（フェーズ2以降で埋める）
│   ├── game/             # ゲーム本体（牌・役・点数）
│   ├── room/             # 部屋管理・マッチング
│   ├── socket/           # WebSocket イベント
│   ├── cpu/              # CPU 代打 AI
│   └── db/               # SQLite 戦績記録
│
└── public/               # ブラウザに配信するファイル
    ├── index.html        # ロビー画面
    ├── play.html         # 対局画面（既存版のコピー）
    ├── css/
    └── js/
```

---

## 🌐 本番デプロイ

無料で公開して友達と遊ぶには **Render** または **Railway** が使えます。
本リポジトリは Render を推奨（`render.yaml` で自動構築できる設定済み）。

### 環境変数

| 変数名 | 必須? | 既定値 | 説明 |
|---|---|---|---|
| `PORT` | 自動 | `3000` | サーバーが listen するポート。Render が自動で渡してくる |
| `HOST` | 任意 | `0.0.0.0` | バインドするホスト。本番では変更不要 |
| `NODE_ENV` | 任意 | `development` | `production` にすると trust proxy 有効・起動ログ簡略化 |
| `DB_PATH` | 任意 | `./data/fever-mj.json` | 戦績データの保存先 |

`.env` ファイル（本番では使わない・ローカルのみ）の例は `.env.example` 参照。

### ヘルスチェック

スリープ防止用に **`/health`** と **`/healthz`** の 2 つを用意（中身は同じ）。
レスポンス例：
```json
{
  "status": "ok",
  "uptime": 1234.5,
  "rooms": 0,
  "statsEnabled": true,
  "nodeEnv": "production"
}
```

---

### 🚀 Render での公開手順（推奨）

#### 1. GitHub にプッシュ

ローカルで Git の初回設定（既にしてあるなら飛ばしてOK）：
```bash
git config --global user.name "あなたの名前"
git config --global user.email "your-email@example.com"
```

GitHub で**新しいリポジトリ**を作成（公開/非公開どちらでも可）。リポジトリ名は例：`fever-mj-server`。
そして以下を実行：
```bash
git remote add origin https://github.com/<あなたのユーザー名>/fever-mj-server.git
git branch -M main
git push -u origin main
```

> 💡 GitHub の認証方法はモダンでは **Personal Access Token** か **SSH キー**。
> 詳細：<https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token>

#### 2. Render にサインアップ

<https://render.com/> で GitHub アカウント連携してサインアップ（無料・クレカ不要）。

#### 3. Web Service を作成

ダッシュボードで **「New +」→「Web Service」** → さきほどの GitHub リポジトリを選択。

Render は **`render.yaml` を自動検出**するので、以下の設定が自動で入ります：
- Runtime: **Node**
- Build Command: **`npm install --omit=dev`**
- Start Command: **`npm start`**
- Plan: **Free**
- Health Check Path: **`/health`**
- Env: `NODE_ENV=production`、`DB_PATH=./data/fever-mj.json`

**「Create Web Service」** をクリック。初回ビルドに 2〜3 分。

#### 4. 公開URL でアクセス

ビルド完了後、`https://fever-mj-server-XXXX.onrender.com` のような URL が払い出されます。
**スマホからもブラウザでアクセス可能**。友達に URL とロビーの合言葉を共有して 3 人対戦！

#### 5. スリープ対策（任意）

Render の Free プランは **15 分間アクセスがないと一時停止**し、復帰に 20〜30 秒かかります。
これを避けるなら **UptimeRobot**（無料）で定期 ping：

1. <https://uptimerobot.com/> でアカウント作成
2. **「+ Add New Monitor」** → Type: **HTTP(s)**
3. URL: `https://<your-app>.onrender.com/health`
4. Monitoring Interval: **5 minutes**
5. 保存

> ⚠️ **既知の制約**: Free プランには永続ディスクがないため、**再デプロイ時に戦績データ（`data/fever-mj.json`）はリセット**されます。スリープ復帰では消えませんが、コード変更でデプロイされると消えます。
> 戦績を恒久保存したい場合は Render の Disk Add-on（有料）、または外部 DB（Supabase, MongoDB Atlas など）への移行を検討してください。

---

### 🚂 Railway での公開手順（代替）

Railway は試用クレジット（500 時間 / 月）の範囲で使えます。

1. <https://railway.app/> で GitHub 連携してサインアップ
2. **「New Project」→「Deploy from GitHub repo」** → リポジトリ選択
3. 自動的に Node.js プロジェクトとして認識される
4. **Settings** タブで以下の環境変数を追加：
   - `NODE_ENV=production`
   - `DB_PATH=./data/fever-mj.json`
5. **Generate Domain** で公開 URL を発行

> Railway は Render と違って `render.yaml` を読まないので、Build/Start コマンドが自動検出されない場合は手動で設定：
> - Build: `npm install --omit=dev`
> - Start: `npm start`

---

### 🧪 デプロイ後の動作確認チェックリスト

公開後、以下を確認してください：

- [ ] ブラウザで `https://<your-app>.onrender.com/` を開いてロビーが表示される
- [ ] `/health` が `{"status":"ok",...}` を返す
- [ ] ソロ練習で 1 局完走できる
- [ ] スマホで同じ URL を開いて操作できる
- [ ] 3 人（自分＋友達 2 人）で部屋に集まれる
- [ ] 全 6 局を完走できる
- [ ] 戦績画面（`/stats.html`）で記録が見える

---

## ライセンス

ローカル開発用。商用利用は未定。
