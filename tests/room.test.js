// ============================================================
// tests/room.test.js
// RoomManager（部屋管理クラス）の動作確認テスト。
// ============================================================
// 実行: npm test
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

const { RoomManager, MAX_PLAYERS } = require('../src/room/manager');

// テスト中は ID とタイムスタンプを固定して動作を検証しやすくする
function makeManager() {
  let now = 1_000_000;
  let idCounter = 0;
  return new RoomManager({
    now: () => now,
    idGen: () => `id-${++idCounter}`,
  });
}

// ============================================================
// 1. 部屋作成
// ============================================================

test('createRoom: 空のマネージャに新規部屋ができる', () => {
  const rm = makeManager();
  const { room, token, playerId } = rm.createRoom({
    password: 'aiueo',
    name: 'たくみ',
    socketId: 'sock-1',
  });

  assert.strictEqual(rm.roomCount(), 1);
  assert.strictEqual(room.state, 'waiting');
  assert.strictEqual(room.players.length, 1);
  assert.strictEqual(playerId, 'P0', '作成者は P0');
  assert.strictEqual(room.players[0].name, 'たくみ');
  assert.strictEqual(typeof token, 'string');
  assert.ok(token.length > 0, 'トークンが発行される');
});

test('createRoom: 同じ合言葉で2部屋目を作るとエラー', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });

  assert.throws(
    () => rm.createRoom({ password: 'aiueo', name: 'B', socketId: 's2' }),
    /既に存在/,
    '同合言葉の待機部屋があれば作成不可'
  );
});

test('createRoom: 名前か合言葉が空ならエラー', () => {
  const rm = makeManager();
  assert.throws(() => rm.createRoom({ password: '', name: 'A', socketId: 's1' }), /合言葉/);
  assert.throws(() => rm.createRoom({ password: 'p', name: '', socketId: 's2' }), /名前/);
});

// ============================================================
// 2. 部屋参加
// ============================================================

test('joinRoom: 同じ合言葉の待機部屋に参加できる', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });

  const result = rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });

  assert.strictEqual(result.playerId, 'P1', '2人目は P1');
  assert.strictEqual(result.room.players.length, 2);
  assert.strictEqual(result.isFull, false, 'まだ2人なので満員ではない');
  assert.strictEqual(result.room.state, 'waiting');
});

test('joinRoom: 3人目が参加すると isFull=true で state=starting に遷移', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });
  rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });

  const result = rm.joinRoom({ password: 'aiueo', name: 'C', socketId: 's3' });

  assert.strictEqual(result.playerId, 'P2', '3人目は P2');
  assert.strictEqual(result.isFull, true);
  assert.strictEqual(result.room.state, 'starting');
  assert.strictEqual(result.room.players.length, 3);
});

test('joinRoom: 合言葉が一致する部屋が無ければエラー', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });

  assert.throws(
    () => rm.joinRoom({ password: '別の合言葉', name: 'B', socketId: 's2' }),
    /見つかりませんでした/
  );
});

test('joinRoom: 満員（3人）の部屋には参加できない', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });
  rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });
  rm.joinRoom({ password: 'aiueo', name: 'C', socketId: 's3' });

  assert.throws(
    () => rm.joinRoom({ password: 'aiueo', name: 'D', socketId: 's4' }),
    /見つかりませんでした|満員/,
    '満員 or 開始済みなので参加不可'
  );
});

// ============================================================
// 3. 退室
// ============================================================

test('leaveRoom: 待機中の最後の人が抜けると部屋が削除される', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });

  const result = rm.leaveRoom('s1');

  assert.strictEqual(result.roomDeleted, true);
  assert.strictEqual(rm.roomCount(), 0);
});

test('leaveRoom: 待機中に1人抜けても他に人がいれば部屋は残る', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });
  rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });

  const result = rm.leaveRoom('s2');

  assert.strictEqual(result.roomDeleted, false);
  assert.strictEqual(result.room.players.length, 1);
  assert.strictEqual(result.room.players[0].name, 'A');
});

test('leaveRoom: 開始済み部屋から抜けても connected=false にするだけ', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });
  rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });
  rm.joinRoom({ password: 'aiueo', name: 'C', socketId: 's3' });
  // この時点で state=starting

  const result = rm.leaveRoom('s2');

  assert.strictEqual(result.roomDeleted, false);
  assert.strictEqual(result.room.players.length, 3, '開始済みは席を残す');
  const p1 = result.room.players.find((p) => p.id === 'P1');
  assert.strictEqual(p1.connected, false);
  assert.strictEqual(p1.socketId, null);
});

test('leaveRoom: 知らない socketId なら null を返す', () => {
  const rm = makeManager();
  assert.strictEqual(rm.leaveRoom('unknown'), null);
});

// ============================================================
// 4. プレイヤーID割り当て（先着順）
// ============================================================

test('途中で抜けた席は次の参加者に割り当てられる', () => {
  const rm = makeManager();
  rm.createRoom({ password: 'aiueo', name: 'A', socketId: 's1' });  // P0
  rm.joinRoom({ password: 'aiueo', name: 'B', socketId: 's2' });    // P1
  rm.leaveRoom('s1');  // P0 が抜けた

  const result = rm.joinRoom({ password: 'aiueo', name: 'C', socketId: 's3' });
  assert.strictEqual(result.playerId, 'P0', '空いている最若の席に割り当て');
});

// ============================================================
// 5. publicView（公開情報フィルタ）
// ============================================================

test('publicView: トークンとソケットIDは含まれない', () => {
  const rm = makeManager();
  const { room } = rm.createRoom({ password: 'p', name: 'A', socketId: 's1' });

  const view = rm.publicView(room);

  assert.strictEqual(view.id, room.id);
  assert.strictEqual(view.state, 'waiting');
  assert.strictEqual(view.players.length, 1);
  assert.deepStrictEqual(
    Object.keys(view.players[0]).sort(),
    ['connected', 'id', 'name']
  );
});

// ============================================================
// 6. 期限切れ部屋の自動削除
// ============================================================

test('cleanupExpiredRooms: 30分以内の部屋は削除されない', () => {
  let now = 1_000_000;
  const rm = new RoomManager({
    now: () => now,
    idGen: ((c) => () => `id-${++c}`)(0),
  });
  rm.createRoom({ password: 'p', name: 'A', socketId: 's1' });

  now += 29 * 60 * 1000;  // 29分後
  const expired = rm.cleanupExpiredRooms();

  assert.strictEqual(expired.length, 0);
  assert.strictEqual(rm.roomCount(), 1);
});

test('cleanupExpiredRooms: 30分超の待機部屋は削除される', () => {
  let now = 1_000_000;
  const rm = new RoomManager({
    now: () => now,
    idGen: ((c) => () => `id-${++c}`)(0),
  });
  rm.createRoom({ password: 'p', name: 'A', socketId: 's1' });

  now += 30 * 60 * 1000 + 1;  // 30分+1ミリ秒後
  const expired = rm.cleanupExpiredRooms();

  assert.strictEqual(expired.length, 1);
  assert.strictEqual(rm.roomCount(), 0);
});

test('cleanupExpiredRooms: 開始済み（starting）の部屋は削除されない', () => {
  let now = 1_000_000;
  const rm = new RoomManager({
    now: () => now,
    idGen: ((c) => () => `id-${++c}`)(0),
  });
  rm.createRoom({ password: 'p', name: 'A', socketId: 's1' });
  rm.joinRoom({ password: 'p', name: 'B', socketId: 's2' });
  rm.joinRoom({ password: 'p', name: 'C', socketId: 's3' });  // state=starting に

  now += 60 * 60 * 1000;  // 1時間後
  const expired = rm.cleanupExpiredRooms();

  assert.strictEqual(expired.length, 0, '対局中の部屋はタイムアウトで削除しない');
});

// ============================================================
// 7. MAX_PLAYERS の定数チェック
// ============================================================

test('MAX_PLAYERS は 3 人麻雀の前提通り 3', () => {
  assert.strictEqual(MAX_PLAYERS, 3);
});
