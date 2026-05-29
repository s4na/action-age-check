# action-age-check

ワークフローで `uses:` している GitHub Actions が「リリースから十分に時間が経過した（枯れた）バージョンか」を検証し、まだ新しすぎるものを検出して CI を失敗させる Action です。

## なぜ必要か

サプライチェーン攻撃は、悪意あるリリースやタグ付け替えが行われた**直後**が最も危険です。Dependabot の `cooldown` や Renovate の `minimumReleaseAge` は「既存依存の**更新**」フローにしか効かず、次のケースは素通りします。

- 開発者が新規ワークフローを書くときに、最新版を手で貼り付ける
- 既存の `uses:` を手作業で最新版に書き換える

この Action は、CI 上で「使われている action が十分に枯れているか」を直接ゲートする、**最終防衛線（pull 型のチェック）** を提供します。

## 使い方

```yaml
name: action-age-check
on:
  pull_request:
    paths:
      - '.github/workflows/**'

permissions:
  contents: read

jobs:
  age-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>  # v4
      - uses: s4na/action-age-check@<SHA>  # v0
        with:
          min-age: 1w        # デフォルト。1d / 2d / 7d / 2w なども可
          fail-level: error
          allow: |
            actions/checkout
```

## 入力

| input | デフォルト | 説明 |
|---|---|---|
| `min-age` | `1w` | 最低経過時間。`1d`, `2d`, `7d`, `1w`, `2w` など。単位なしの整数は日。`w`=週。不正値はエラーで fail |
| `paths` | `.github/workflows` | 走査対象（改行区切りで複数可。ディレクトリ／ファイル両対応） |
| `allow` | （空） | チェックを除外する `owner/repo` または `owner/repo@ref`（改行区切り） |
| `fail-level` | `error` | `error`=job を失敗させる / `warning`=注釈のみ |
| `include-local` | `false` | 予約。ローカル(`./`)/`docker://` の扱い（現状はスキップ） |
| `token` | `${{ github.token }}` | GitHub API 呼び出し用トークン |

## 出力

| output | 説明 |
|---|---|
| `checked-count` | チェックしたリモート参照の数 |
| `violation-count` | min-age 未満（または判定不能）だった数 |
| `violations` | 違反の詳細（JSON 配列） |

## age の判定基準（優先順）

「公開日」をできるだけ正確に取るため、次の順で基準を選びます。

1. **GitHub Release の `published_at`** — 最も信頼できる
2. **annotated tag の `tagger.date`**
3. **commit の `committer.date`** — フォールバック

### ⚠ commit date の落とし穴

commit の日時は「その commit が作られた日」であって「公開日」ではありません。攻撃者が**古い commit に新しくタグを付け替える**と、commit date が古いため age チェックを素通りする可能性があります（tag 付け替え型攻撃）。SHA pin や cooldown と**併用**することを前提とした、多層防御の一層として使ってください。

## 設計上の方針

- **fail-closed**: API エラーなどで age を判定できない場合は、黙って pass せず違反として扱います（安全側に倒す）。
- ブランチ pin（`@main` など）は mutable かつ age 不定のため、常に違反扱いです。
- 依存ゼロの Node 24 action（`runs.using: node24`）。ビルド成果物（dist）のコミットは不要です。

## 関連

- Dependabot `cooldown` / Renovate `minimumReleaseAge`（push 型・既存更新のみ）
- zizmor `unpinned-uses`（pin の有無のみ）/ `dependabot-cooldown`（設定有無のみ）

これらでカバーされない「新規追加・手書き変更された action の age を CI でゲートする層」を本 Action が担います。

## 開発

```bash
node --test
```

## License

MIT
