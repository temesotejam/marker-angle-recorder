# Marker Angle Recorder

研究実験向けの、ブラウザで動く機体角度計測・動画記録・RWLOG対応付けツールです。

## Version 1 の目的

1回の実験を、1つの変更されないSessionとしてまとめます。

```text
カメラ -> 生動画
       -> マーカー認識 -> 角度CSV
RWLOG  -> 互換性 / CRC / 受動監査 / 時間確認
                                  |
                                  v
                         Session manifest
                                  |
                                  v
                              1つのZIP
```

主目的は、**動画とRWLOGの取り違えを防ぐこと**と、カメラから独立した物理ロール角を確認できるようにすることです。

## マーカー認識方式

マーカー認識は、新しい方式へ置き換えません。

`video-rwlog-angle-analyzer/src/analysis.js` で使用していた既存の**白丸2点認識・ROI追跡方式**を、そのしきい値を変更せずリアルタイム入力へ移植しています。

処理は次のとおりです。

1. 認識入力を1280×720へ正規化
2. 初期探索範囲 `[300, 380, 700, 140]` から白丸候補を抽出
3. 白丸2点の面積・形状・左右距離・上下差からペアを決定
4. 左右それぞれ `96×90 px` のROIで追跡
5. 白領域にopening/closingを適用
6. 前フレーム中心に最も近い候補を継続採用
7. 見失った場合のみROIを1.8倍へ拡張
8. 左右マーカー中心を結ぶ線から角度を算出

既存値は `tests/marker.test.mjs` で固定しており、CIで意図せず変更されていないことを確認します。

## 角度基準

研究用の標準は **絶対角度（固定水平基準）** です。

```text
camera_line = -atan2(y2-y1, x2-x1)
absolute_angle = sign * wrapped(camera_line - fixed_horizontal_reference)
```

固定水平基準はカメラ設置時の校正値としてブラウザに保存します。runごとに機体姿勢から引き直しません。

受動研究では、**runごとのゼロ引きを行いません**。`相対ZERO（確認用のみ）` は画面確認用として残していますが、CSVとmanifestにも相対モードであることを明示します。

詳しくは [`docs/ANGLE_REFERENCE.md`](docs/ANGLE_REFERENCE.md) を参照してください。

## 測定手順

1. GitHub PagesをHTTPSで開く
2. USBカメラを開始する
3. 白丸2点が認識されることを確認する
4. 認識が違う場合は **マーカー再検出** を押す
5. 研究データ取得では `絶対角度（固定水平基準）` を使う
6. カメラ設置に対応した固定水平基準を確認する
7. 既知の正方向へ機体を傾け、必要なら **符号反転** を行い、**符号を確認** を押す
8. **録画開始** を押して実験し、終了後に **停止** を押す
9. そのrunで取得したRWLOGを追加する
10. SHA-256、CRC、RWLOG形式、受動監査、記録時間、重複、ペア判定を確認する
11. Session ZIPを書き出す

録画済みSessionを出力する前に、新しいSessionで上書きすることはできません。`要確認` / `不一致` の場合は明示的な手動確認が必要です。RWLOGなしで保存する場合は緊急保存を明示します。

## ZIP構成

```text
<session-id>.zip
├── <session-id>_video_raw.webm
├── <session-id>_angle.csv
├── <session-id>_log.rwlog
└── <session-id>_manifest.json
```

動画にはマーカー表示を焼き込みません。後から別の認識処理で再解析できるよう、生のカメラ映像を保存します。

角度CSVには、カメラ上の機体基準線、固定水平基準、絶対角度、任意の相対角度、生角度、表示用平滑角、左右マーカー座標、マーカー間距離、ROI追跡状態、Session時間、動画フレーム時間を保存します。

## 現行RWLOG v41

現在のV62由来受動ロガーはRWLOGファイル形式 **v41** を使用します。

- magic: `RWLOG01`
- little-endian
- 110 byte header
- UTF-8 JSON metadata
- 146 byte 固定長sample
- log周期 20 ms / IMU更新周期 5 ms
- 末尾CRC32: header + metadata + samplesを対象

v41受動測定では、全sampleについて次を監査します。

- `motor_cmd_mA == 0`
- `current_mA_setting == 0`
- `pulse_active == 0`
- `pulse_id == 0`

JSONメタデータについても次を確認します。

- `passive_capture_mode == true`
- `q_run_mode == "none"`

`roller_actual_current_mA` はRollerの生テレメトリなので、非ゼロ指令の証拠としては使いません。

## RWLOGの将来互換性

将来RWLOG形式が変わっても、Recorder全体が使えなくならない構成にしています。

1. 選択されたログファイルは、解析できなくても原本のままZIPへ保存できる
2. `RWLOG01` 共通ヘッダが読める場合はversion、run ID、sample数、CRC等を確認する
3. 共通sample prefix `time_us, t_test_ms` が安全に読める場合は時間確認に使う
4. 既知versionには詳細decoder / auditorを追加できる
5. 未知の将来versionでも、詳細decoderがなくてもSessionへ添付できる

動画との大まかな時間比較には、原則として `time_us` から得る全ログ時間を使います。`t_test_ms` は開始LEDシグネチャ終了後を0とする実験時間として別に保持します。

詳しくは [`docs/RWLOG_COMPATIBILITY.md`](docs/RWLOG_COMPATIBILITY.md) を参照してください。

## ローカル処理

カメラ映像、マーカー認識、動画記録、RWLOG確認、SHA-256、ZIP作成はすべてブラウザ内で行います。測定ファイルを外部サービスへアップロードしません。

## 推奨ブラウザ

USBカメラ選択とMediaRecorderの互換性から、Chromium系デスクトップブラウザを推奨します。GitHub PagesはカメラAPIに必要なHTTPS環境を提供します。

## 開発

ビルド不要の静的HTML/CSS + ES modulesで構成しています。GitHub ActionsでJavaScript構文、RWLOG互換性、既存マーカー認識定数を検証し、`main` 更新後にGitHub Pagesへデプロイします。
