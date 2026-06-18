// ============================================================
// src/socket/auth.js
// 永続プレイヤーID（persistentPlayerId）のなりすまし対策。
// ============================================================
// 仕組み:
//   - サーバー秘密鍵 SECRET から HMAC-SHA256 で playerId に署名を発行
//   - クライアントは「id + sig」のペアを localStorage に保存
//   - サーバーは戦績書き込み時に sig を検証 → 一致しなければ匿名扱い
//
// SECRET の取得順:
//   1. 環境変数 STATS_SECRET
//   2. なければプロセス起動時にランダム生成（プロセス再起動で sig は無効化）
//      - 本番では必ず STATS_SECRET を設定するよう README に明記推奨
// ============================================================

const crypto = require('crypto');

// 起動時に1度だけ決定（プロセスが生きている間は変わらない）
let SECRET = process.env.STATS_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] STATS_SECRET 未設定 → 起動時に自動生成しました。');
  console.warn('[auth] 本番では環境変数 STATS_SECRET に固定値を設定してください。');
  console.warn('[auth] 未設定だと再起動でクライアント側 sig が無効化されます（戦績記録は維持されるが、署名再発行が必要）。');
}

// playerId に署名を発行（HMAC-SHA256・先頭 32 文字）
// 戻り値: 16進数文字列（32 文字）
function signPlayerId(playerId) {
  if (typeof playerId !== 'string' || playerId.length === 0) return null;
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(playerId);
  // 32 文字に切り詰めても十分なエントロピー（128 bit）
  return hmac.digest('hex').slice(0, 32);
}

// 署名を検証
// 一致すれば true、それ以外（不正・未指定・型違い）は false
// crypto.timingSafeEqual でタイミング攻撃を防ぐ
function verifyPlayerSig(playerId, sig) {
  if (typeof playerId !== 'string' || typeof sig !== 'string') return false;
  const expected = signPlayerId(playerId);
  if (!expected) return false;
  if (expected.length !== sig.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(sig, 'utf8')
    );
  } catch {
    return false;
  }
}

module.exports = {
  signPlayerId,
  verifyPlayerSig,
};
