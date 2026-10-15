-- 만다라트 AI 피드백 앱 기본 스키마(v1, 마이그레이션 id '0001_base') (Neon Postgres)
-- 앱이 DB에 처음 접속할 때 이 내용을 자동으로 실행합니다(src/lib/db.ts의 ensureSchema). 직접 실행할 필요는 없습니다.
-- 여러 번 실행해도 안전하게(if not exists) 썼습니다. 모든 접근은 Next.js 서버에서만 하므로
-- 모든 표에 RLS를 켜고 정책은 두지 않습니다(혹시 공개 키로 접근해도 아무것도 읽을 수 없음).
-- 이 파일을 고치면 node tests/gen-schema-sql.mjs로 src/lib/schema-sql.ts를 다시 만드세요(tests/schema.test.ts가 비교합니다).
--
-- ⚠️ 한 번이라도 배포한 뒤에는 이 파일을 고치지 마세요. 이미 설치된 DB에서는 다시 실행되지 않습니다(schema_migrations에 기록됨).
-- 표·열·제약을 바꾸려면 src/lib/migrations.ts의 LATER_MIGRATIONS에 새 마이그레이션(0002_…)을 덧붙이세요.

-- 앱 설정(자동으로 만든 로그인 비밀값, 스키마 버전 등)
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- 교사 계정
create table if not exists teachers (
  id uuid primary key default gen_random_uuid(),
  login_id text not null unique,
  display_name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- 학급. is_open이 false이면 학생은 로그인해서 볼 수만 있고 고치기·피드백·제출은 못 합니다.
create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references teachers(id) on delete cascade,
  name text not null,
  class_code text not null unique,
  is_open boolean not null default true,
  max_feedback_rounds smallint not null default 2 check (max_feedback_rounds between 1 and 2),
  created_at timestamptz not null default now()
);
create index if not exists classes_teacher_idx on classes (teacher_id, created_at);

-- 학생: 학급 코드 + 번호 + 이름 + 4자리 PIN으로 로그인합니다. 이름은 외부 AI로 보내지 않습니다.
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references classes(id) on delete cascade,
  number smallint not null check (number between 1 and 99),
  name text not null,
  pin text check (pin ~ '^[0-9]{4}$'),
  failed_logins smallint not null default 0,
  locked_until timestamptz,
  -- 교사가 이 학생의 안전 신호(표현 검사·AI 신호)를 '확인했어요'로 표시한 시각. 이 뒤에 새로 생긴 신호만 다시 '살펴볼 학생'으로 셉니다.
  concern_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (class_id, number)
);

-- 만다라트(학생 1명당 1개)
-- content: {"goal": "", "subs": [8], "actions": [[8] x 8]}
create table if not exists mandalarts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null unique references students(id) on delete cascade,
  content jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,
  -- 저장 번호(src/lib/save-rules.ts). 글을 저장할 때마다 올리며, 한 번에 여러 개를 건너뛸 수 있습니다(nextRevision: 결과를 모르는
  -- 앞선 저장이 늦게 도착해도 받아들여지지 않게). 서버 글과 똑같은 글을 다시 보내면 올리지 않기도 합니다. 오래된 탭·다른 기기가
  -- 더 새 글을 덮어쓰지 못하게, 저장·제출은 화면이 이 번호(또는 그 화면이 보낸 글)를 알 때만 됩니다.
  revision integer not null default 0,
  -- 규칙 기반 안전 신호(src/lib/concern-rules.ts, AI와 별개, 교사 화면에만 표시): 지금까지 걸린 것 중 가장 무거운 종류와 마지막으로 걸린 시각.
  -- 자동 저장·제출 때마다 검사합니다. 종류는 더 가벼운 것으로 바뀌지 않고, 글을 고쳐 더 걸리지 않아도 지우지 않습니다.
  -- rule_concern_current는 마지막 저장 때 걸렸는지입니다. 지워졌다가 다시 걸리면 시각을 새로 적습니다.
  rule_concern_kind text check (rule_concern_kind in ('self_harm', 'abuse', 'bullying', 'eating', 'violence', 'other')),
  rule_concern_at timestamptz,
  rule_concern_current boolean not null default false,
  -- AI 피드백을 만드는 중이면 그 표시가 풀리는 시각(동시 요청·중복 과금 방지, src/lib/feedback/round.ts)
  feedback_pending_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 피드백 요청 1회(단계: core = 중심·세부 목표, block = 블록 하나, whole = 전체 / attempt 2 = 확인 피드백)
-- concern: AI가 글에서 학생의 안전·안녕이 걱정되는 신호를 보았는지(교사 화면에만 표시)
-- model: 실제로 응답한 모델(·제공사), diagnosis: 진단 항목·고른 카드·사용량(비용 확인용)
create table if not exists feedback_rounds (
  id uuid primary key default gen_random_uuid(),
  mandalart_id uuid not null references mandalarts(id) on delete cascade,
  round_no smallint not null,
  stage text not null check (stage in ('core', 'block', 'whole')),
  block_index smallint check (block_index between 0 and 7),
  attempt smallint not null default 1 check (attempt between 1 and 2),
  content_snapshot jsonb not null,
  diagnosis jsonb not null,
  model text,
  concern boolean not null default false,
  concern_kind text check (concern_kind in ('self_harm', 'abuse', 'bullying', 'eating', 'violence', 'other')),
  created_at timestamptz not null default now(),
  unique (mandalart_id, round_no),
  check ((stage = 'block') = (block_index is not null))
);
create index if not exists feedback_rounds_concern_idx on feedback_rounds (mandalart_id, created_at) where concern;

-- 학생에게 보여 준 피드백 카드(issue = 고칠 점, resolved = 해결됨, unresolved = 아직 해결 안 됨)
create table if not exists feedback_cards (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references feedback_rounds(id) on delete cascade,
  position smallint not null,
  category text not null,
  target jsonb not null,
  body text not null,
  kind text not null default 'issue' check (kind in ('issue', 'resolved', 'unresolved')),
  prev_card_id uuid references feedback_cards(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (round_id, position)
);
create index if not exists feedback_cards_prev_idx on feedback_cards (prev_card_id) where prev_card_id is not null;

-- 카드에 대한 학생 반응('해 볼게요' / '안 할래요', 이유는 선택). 마음을 바꾸면 새 행이 쌓이고 최신 행이 유효합니다.
create table if not exists feedback_responses (
  id bigint generated always as identity primary key,
  card_id uuid not null references feedback_cards(id) on delete cascade,
  action text not null check (action in ('accept', 'reject')),
  reason_code text check (reason_code in ('already_ok', 'not_my_goal', 'dont_understand', 'other_way', 'other')),
  reason_text text check (char_length(reason_text) <= 100),
  created_at timestamptz not null default now(),
  check (action = 'reject' or (reason_code is null and reason_text is null))
);
create index if not exists feedback_responses_card_idx on feedback_responses (card_id, created_at desc);

-- 기록: 학생 로그인(login), 로그인 잠금(login_locked)·잠금 해제(login_unlocked), 피드백 오류(feedback_error: 코드만),
-- 교사 로그인 시도(teacher_login_fail, student_id 없음), 교사 비밀번호 다시 정하기(teacher_password_reset, student_id 없음).
-- PIN·이름·만다라트 글은 남기지 않습니다.
create table if not exists event_log (
  id bigint generated always as identity primary key,
  student_id uuid references students(id) on delete cascade,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists event_log_student_idx on event_log (student_id, created_at) where student_id is not null;
-- 종류별 최근 기록 찾기(교사 로그인 늦추기, 설정 코드 시도, 교사 화면의 최근 피드백 오류)
create index if not exists event_log_type_idx on event_log (type, created_at);

alter table app_settings enable row level security;
alter table teachers enable row level security;
alter table classes enable row level security;
alter table students enable row level security;
alter table mandalarts enable row level security;
alter table feedback_rounds enable row level security;
alter table feedback_cards enable row level security;
alter table feedback_responses enable row level security;
alter table event_log enable row level security;
