# 만다라트 AI 피드백 앱

중학생(13~15세)이 만다라트를 쓰고 AI 단계별 피드백(중심 → 블록 8개 → 전체, 단계마다 확인 피드백 1회)을 받아 고치는 무료 수업용 앱입니다. 교사 한 명 한 명이 GitHub에서 Vercel Deploy 버튼으로 자기 Vercel Hobby 계정 + Neon 무료 DB에 설치합니다. 사용자는 한국 중학교 교사이며 한국어로 소통합니다. 연구 기능(동의, 배정, 조건, 사전·사후, 검사, 평정 내보내기)은 없습니다. 다시 넣지 마세요.

## 꼭 지킬 것
- **학생 이름·번호·PIN은 AI 프롬프트에 절대 넣지 않습니다.** AI에는 만다라트 글만 보냅니다.
- **학생 PIN(`students.pin`)은 로그, CSV, 오류 메시지에 남기지 않습니다.**
- **설치는 비개발자 교사 기준으로 최소한으로.** Deploy 버튼에서 직접 넣는 값은 `OPENROUTER_API_KEY`, `SETUP_TOKEN` 두 개뿐입니다. `DATABASE_URL`(Neon 풀링 주소)은 자동 주입되고, 레거시 `POSTGRES_URL`은 있을 수도 있음(코드는 `DATABASE_URL`이 없을 때만 씀). 새 필수 환경 변수, 수동 SQL 실행, cron, 유료 플랜이 필요한 기능을 추가하지 마세요. DB 표는 앱이 스스로 만들고(멱등), 스키마 변경도 앱이 자동으로 적용해야 합니다.
- **교사 사본은 Deploy 버튼이 만든 복제본(clone)이지 fork가 아닙니다.** 업데이트는 `.github/workflows/update-from-template.yml`(Actions의 '앱 업데이트', 수동 실행)이 원본 main을 덮어써서 받습니다. 이때 `.github/`는 바뀌지 않으므로(GITHUB_TOKEN은 workflow 파일을 push할 수 없음) workflow를 고쳐도 이미 설치한 교사에게는 전달되지 않습니다. 이미 설치된 앱의 DB도 새 코드가 첫 요청 때 스스로 고쳐야 합니다(옛 스키마에서 올라오는 경로를 깨뜨리지 마세요).
- Vercel 함수 리전은 `sin1`(싱가포르, Neon `aws-ap-southeast-1` 옆). Hobby는 리전 1개만 가능합니다. 피드백 함수의 `maxDuration` 300초는 Fluid compute가 켜져 있어야 하므로 `vercel.json`에 `"fluid": true`를 둡니다.
- 화면 문구는 중학생과 교사가 읽는 쉬운 한국어로 씁니다. 설치·수업 안내는 `docs/설치_안내.md`, `docs/수업_사용_안내.md`. 설치 흐름이나 화면 문구를 바꾸면 이 문서도 함께 고칩니다(문서는 화면 글자를 그대로 인용합니다).
- ⚠️ 안전 신호는 교사가 직접 살펴보라는 힌트일 뿐 진단이 아닙니다. 학생 화면에는 보이지 않고, CSV에도 넣지 않습니다. 학급 화면(이름·종류)과 학생 상세 화면(종류·걸린 칸 주황 테두리·회차별 AI 신호, `SafetyReveal.tsx`) 모두 기본으로 숨기고 '안전 신호 보기'를 누를 때만 보여 줍니다(저장하지 않음, 숨긴 동안의 문구는 신호가 없는 학생과 같음). 표현 검사(`src/lib/concern-rules.ts`)는 놓치지 않는 쪽이 먼저입니다: 학생 자신의 괴로움('자해 안 하기' 같은 부정형 목표 포함)은 넓게 잡고, 예외는 구절 모양으로만 좁게 두며, 잘못 걸린 것은 교사가 '확인했어요'로 넘깁니다. 표현을 고치면 시험 말뭉치 `tests/concern-corpus.ts`(걸릴 글·안 걸릴 글·알고 둔 오탐과 놓침, b9bca8b 규칙과의 비교. `tests/safety.test.ts`가 돌림)에 글을 더하고, `docs/수업_사용_안내.md` 2-4에 인용한 예시도 `matchConcernText`로 다시 확인합니다. '확인했어요' 뒤 다시 띄우는 기준은 `src/lib/rule-concern-state.ts`입니다(문서 2-4와 맞출 것). 표현 목록을 학생 화면 번들에 넣지 마세요(`save-rules.ts`는 가져오지 않음).
- 학생 만다라트 저장·제출은 `src/lib/save-mandalart.ts` 한 곳에서 `mandalarts.revision`으로 확인합니다(오래된 탭·다른 기기가 새 글을 덮어쓰지 않게, 규칙은 `save-rules.ts`의 순수 함수). 화면은 요청마다 아는 번호(`revision`), 결과를 모르는 저장의 내용 지문(`prev`)과 보낸 횟수(`sends`), 먼저 보낸 저장이 받아들여질 수 있는 가장 큰 번호(`horizon`)를 보내고, 서버는 저장하면 번호를 `horizon`보다 크게 올려(`nextRevision`, 번호는 건너뛸 수 있음) 늦게 도착한 옛 요청이 새 글을 덮지 못하게 합니다. 같은 글이 다시 와도 먼저 보낸 저장이 더는 받아들여질 수 없으면 번호를 올리지 않습니다(`saveDecision`). 409 stale을 받은 화면은 서버 글을 다시 읽어 자기가 보낸 글이면 번호를 맞춰 이어서 저장하고(`adoptIfOwn`), 새로 고친 탭은 앞 화면이 sessionStorage로 넘긴 지문과 `horizon`을 이어받아(`makeHandoff`·`seedSync`, 지문은 서버에 보내지 않음) 2초 뒤 다시 읽은 서버 글이 그 글이면(또는 아직 아무것도 고치지 않았으면) 알림 없이 받아들입니다(`takeLanded`). 그래서 인터넷이 끊겼던 탭이나 새로 고친 탭을 '다른 탭'으로 오해하지 않습니다. 피드백 요청도 같은 규칙으로 확인합니다. 번호를 보내지 않는 옛 화면(업데이트 전부터 열려 있던 화면)은 409 stale로 멈추므로 문서는 '앱 업데이트'를 수업 밖에 하라고 안내합니다. 칸 글 길이는 화면·서버 모두 UTF-16 단위로 세고(이모지 하나 = 2, `mandalart.ts`의 `MandalartContent`), 자를 때 이모지 반쪽(외톨이 서로게이트)을 남기지 않습니다(`student.ts`의 `clampText`, 서버는 `wellFormedContent`로 고쳐 저장).
- 학생 PIN은 학급마다 끌 수 있습니다(`classes.require_pin`, 기본 켬, 마이그레이션 `0002_class_require_pin`). 끄면 같은 반 친구가 학급 코드·번호·이름만으로 다른 학생으로 들어가 글을 고치거나 지우거나 제출하고, 피드백 기회를 쓰거나, 안전 신호를 엉뚱한 학생에게 붙게 할 수 있어 시범 수업처럼 짧게 쓸 때만 끕니다. 끈 학급은 PIN을 보지 않고 실패를 세거나 잠그지 않으며(남은 `locked_until`도 무시), 로그인 실패 문구는 켠 학급과 같습니다(학급이 PIN을 쓰는지 알려 주는 곳을 두지 마세요). 학생 세션 지문(`pin.ts`의 `pinFingerprint`)에 이 설정이 들어 있어 켜고 끌 때 그 학급 학생이 모두 로그아웃됩니다(켠 학급의 지문은 이 설정 전과 같아 업데이트로는 로그아웃되지 않음). 켜고 끌 때 학급의 잠금과 잠금 단계를 풀고('login_unlocked'), 켤 때 PIN이 없는 학생에게 PIN을 만듭니다. PIN을 쓰는 학급에서 PIN 칸을 비워 보낸 로그인은 실패 횟수에 넣지 않습니다(같은 실패 문구). 끄더라도 PIN은 지우지 않습니다.
- `SETUP_TOKEN`은 첫 교사 계정 만들기와 교사 비밀번호 다시 정하기(`/teacher/setup`)에 씁니다. 계정을 만든 뒤에도 비밀번호를 다시 정하는 마스터 키입니다(코드는 16자 이상을 받고, 문서는 20자 이상 무작위를 권함).
- 비밀값(DB 주소, API 키 등)을 저장소나 대화에 적지 않습니다.
- Next.js 16 사용: 코드를 쓰기 전에 `node_modules/next/dist/docs/`를 확인하세요(AGENTS.md 참고).
- 커밋 작성자는 GitHub 계정 Byeongeo(`256120193+Byeongeo@users.noreply.github.com`)로 합니다. Vercel 무료 플랜이 작성자를 확인합니다.

## 검증
- 타입·린트: `npx tsc --noEmit && npx eslint src tests`
- 단위 테스트: `node --experimental-strip-types --test tests/*.test.ts`
- 로컬 실행: `.env.local`에 `FEEDBACK_MOCK=1`이면 AI 없이 동작(운영 배포에서는 무시)
