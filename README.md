# 만다라트 AI 피드백

> **처음 설치하는 선생님은 여기부터:** [🧭 설치 따라하기 페이지 열기](https://claude.ai/artifact/6h9y3FthGeNLBTX5JsstxA) — GitHub 가입부터 앱 완성까지 버튼을 누르며 8단계로 따라 하면 됩니다.
> 페이지가 열리지 않으면 [설치 따라하기 파일(HTML)](docs/설치_따라하기.html)을 열어 오른쪽 위 **Download raw file**(⤓)로 내려받은 뒤, 내려받은 파일을 더블클릭해 브라우저로 여세요.

중·고등학생이 만다라트(중심 목표 1개 + 세부 목표 8개 + 실천 행동 64개)를 쓰고, AI에게 단계별 피드백을 받아 스스로 고쳐 보는 수업용 웹 앱입니다.
선생님 한 분이 자기 무료 계정에 직접 설치해서 씁니다. 설치는 15분 안팎이면 끝납니다.

- **학생**: 학급 코드 + 번호 + 이름 + 4자리 PIN으로 들어와 만다라트를 씁니다(시범 수업처럼 짧게 쓸 때는 학급마다 PIN을 끌 수 있지만, 그러면 친구가 다른 학생으로 들어갈 수 있어 기본은 켬입니다). 피드백은 ① 중심·세부 목표 → ② 블록 8개 → ③ 전체 순서로 받고, 단계마다 고친 뒤 확인 피드백을 한 번 더 받을 수 있습니다. 카드마다 '해 볼게요' / '안 할래요'를 고르고(이유는 쓰고 싶을 때만) 제출합니다.
- **교사**: 명렬표를 붙여 넣어 학급을 만들고(학급마다 학교급 **중학교**/**고등학교** 를 정하면 AI 진단 기준과 카드 질문 수준이 그에 맞춰짐), 학생별 PIN이 적힌 안내 카드를 인쇄하고, 학생 진행 상황과 AI 연결 상태를 보고, 학급 결과를 CSV로 내려받습니다.
- **비용**: Vercel(웹 호스팅)과 Neon(데이터베이스)은 무료 플랜으로 충분합니다. AI 사용료만 OpenRouter에 선불로 냅니다(30명 학급 1차시에 몇 달러 이내로 예상, 자세한 내용은 설치 안내 참고).
- **개인정보**: 학생 이름은 선생님 본인의 데이터베이스에만 저장되고 AI로 보내지 않습니다. AI에는 만다라트 글만 보냅니다.

## 설치하기

아래 버튼을 누르고 [설치 안내](docs/설치_안내.md)를 따라 하세요.

[![Vercel로 설치하기](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FByeongeo%2Fmandalart-ai-feedback&project-name=mandalart&repository-name=mandalart&env=OPENROUTER_API_KEY,SETUP_TOKEN&envDescription=OpenRouter%20API%20%ED%82%A4%EC%99%80%20%EC%84%A4%EC%A0%95%20%EC%BD%94%EB%93%9C%2820%EC%9E%90%20%EC%9D%B4%EC%83%81%20%EB%AC%B4%EC%9E%91%EC%9C%84%2C%20%EA%B5%90%EC%82%AC%20%EA%B3%84%EC%A0%95%20%EB%A7%8C%EB%93%A4%EA%B8%B0%EC%99%80%20%EB%B9%84%EB%B0%80%EB%B2%88%ED%98%B8%20%EB%8B%A4%EC%8B%9C%20%EC%A0%95%ED%95%98%EA%B8%B0%EC%97%90%20%EC%94%80%29%EB%A5%BC%20%EB%84%A3%EC%9C%BC%EC%84%B8%EC%9A%94.&envLink=https%3A%2F%2Fgithub.com%2FByeongeo%2Fmandalart-ai-feedback%2Fblob%2Fmain%2Fdocs%2F%EC%84%A4%EC%B9%98_%EC%95%88%EB%82%B4.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

버튼이 하는 일:

1. 이 저장소를 선생님 GitHub 계정에 **복사(clone)** 합니다. fork가 아니어서 GitHub의 'Sync fork' 버튼은 나오지 않습니다. 업데이트는 아래 '앱 업데이트'로 받습니다.
2. Vercel 무료(Hobby) 계정에 웹 앱을 만듭니다(서버 위치: 싱가포르 `sin1`).
3. Vercel Marketplace에서 Neon 무료 데이터베이스를 만들어 연결합니다(`DATABASE_URL`이 자동으로 들어감).
4. `OPENROUTER_API_KEY`(AI 키)와 `SETUP_TOKEN`(설정 코드, 20자 이상 무작위 권장) 두 값만 물어봅니다. 설정 코드는 교사 비밀번호를 다시 정할 때도 쓰는 마스터 키이므로 남에게 알려 주지 마세요.

배포가 끝나면 `https://<내 앱 주소>/teacher/setup`에서 첫 교사 계정을 만듭니다. 데이터베이스 표는 앱이 처음 실행될 때 자동으로 만들어집니다.

## 앱 업데이트 받기

원본이 고쳐지면 **교사 화면 맨 아래의 앱 업데이트 카드**에서 받습니다. 카드에는 지금 버전이 나오고, 원본에 새 버전이 있으면 '새 버전 …이 있어요'가 함께 나옵니다.

1. **처음 한 번만**: **업데이트 기능 설치 (처음 한 번)** 을 누르고, 열린 GitHub 화면에서 초록 **Commit changes…** → **Commit changes** 를 누릅니다. Deploy 버튼이 만든 저장소에는 업데이트 기능(`.github/workflows`)이 따라오지 않아서, 그전에는 GitHub **Actions** 탭에 'Get started with GitHub Actions'만 보입니다.
2. **업데이트할 때마다**: **업데이트 받기** 를 누르고, 열린 GitHub 화면에서 **Run workflow** → 초록 **Run workflow** 를 누릅니다.
3. 1~2분 뒤 초록 ✓ 가 되면 끝입니다. Vercel이 몇 분 안에 자동으로 다시 배포하고, 데이터베이스는 새 버전이 처음 열릴 때 스스로 바뀝니다.

교사 화면에 이 카드가 없으면 카드가 생기기 전에 설치한 앱입니다. [설치 안내 5-3. 직접 넣기](docs/설치_안내.md#5-3-직접-넣기-카드가-없거나-편집-칸이-비어-있을-때)로 업데이트 기능을 넣고, GitHub **Actions** 탭 → **앱 업데이트** → **Run workflow** → 초록 **Run workflow** 로 한 번 받으면 카드가 생깁니다.

수업 중에는 하지 마세요(업데이트 전부터 열려 있던 학생 화면은 저장을 멈출 수 있습니다). GitHub 편집 칸이 비어 있을 때 직접 넣는 방법과 자세한 내용은 [설치 안내 5. 앱 업데이트 받기](docs/설치_안내.md#5-앱-업데이트-받기)를 보세요.

## 안내 문서

- [설치 안내](docs/설치_안내.md) — 계정 준비, 설치, 설치 확인, 앱 업데이트, 비밀번호·설정 코드·AI 모델 바꾸기, 문제 해결, 비용, 데이터와 개인정보
- [수업 사용 안내](docs/수업_사용_안내.md) — 수업 전·중·후에 할 일, 학교급(중학교/고등학교)과 학생 PIN 설정, 학생 화면, ⚠️ 안전 신호와 '확인했어요', 결과 내려받기, 자주 생기는 상황

## 개발자용

```bash
npm install
cp .env.example .env.local      # 값 채우기. API 키 없이 화면만 보려면 FEEDBACK_MOCK=1
npm run dev
```

- 스택: Next.js 16(App Router) · Postgres(Neon, postgres.js) · OpenRouter(모델은 `OPENROUTER_MODEL`, 기본 `anthropic/claude-haiku-5.5`)
- 테스트: `node --experimental-strip-types --test tests/*.test.ts`
- 타입·린트: `npx tsc --noEmit && npx eslint src tests`
- 설정 값: [.env.example](.env.example) · Vercel 설정: `vercel.json`(리전 `sin1`, Fluid compute 켬)
- 업데이트 workflow: `.github/workflows/update-from-template.yml` — 교사 사본에서 원본 main을 덮어씀(`.github/` 제외). Deploy 복제본에는 따라오지 않으므로 교사 화면 카드의 GitHub 새 파일 링크로 한 번 넣습니다. 링크에 넣는 내용은 `src/lib/update-workflow-yml.ts`(workflow를 고치면 `node tests/gen-update-workflow.mjs`로 다시 만듦)
- 버전: `package.json`의 `version`. 원본에 올리는 변경마다 올립니다(교사 화면이 원본 main의 버전과 비교해 새 버전을 알림)
- License: MIT (LICENSE 파일)
