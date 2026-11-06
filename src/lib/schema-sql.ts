// db/schema.sql과 글자 하나까지 같은 사본입니다. 직접 고치지 말고 `node tests/gen-schema-sql.mjs`로 다시 만드세요.
// 배포된 앱은 파일을 읽지 않고 이 문자열을 실행합니다(src/lib/db.ts의 ensureSchema). tests/schema.test.ts가 두 내용을 비교합니다.
export const SCHEMA_SQL = String.raw`-- 만다라트 AI 피드백 앱 기본 스키마(Cloudflare D1 = SQLite, 마이그레이션 id '0001_base')
-- 앱이 DB에 처음 접속할 때 이 내용을 자동으로 실행합니다(src/lib/db.ts의 ensureSchema). 직접 실행할 필요는 없습니다.
-- 여러 번 실행해도 안전하게(if not exists) 썼습니다.
--
-- Postgres판(v1, Vercel+Neon)과의 차이:
-- - id는 앱이 만든 uuid 문자열(crypto.randomUUID), 시각은 ISO-8601 UTC 문자열(밀리초까지, 예: 2026-11-06T01:02:03.456Z).
--   같은 모양이라 글자 비교 = 시각 비교입니다. DB에서 지금 시각은 NOW_SQL(strftime('%Y-%m-%dT%H:%M:%fZ','now'))로 만듭니다.
-- - 참/거짓은 0/1 정수, jsonb는 JSON 글(text)입니다. src/lib/db.ts가 읽을 때 열 이름으로 boolean·JSON·Date로 바꿔 줍니다.
-- - Postgres판 마이그레이션 0002(require_pin)·0003(school_level)은 처음부터 표에 들어 있습니다.
--
-- ⚠️ 한 번이라도 배포한 뒤에는 이 파일을 고치지 마세요. 표·열·제약을 바꾸려면 src/lib/migrations.ts의 LATER_MIGRATIONS에 새 마이그레이션을 덧붙이세요.

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists teachers (
  id text primary key,
  login_id text not null unique,
  display_name text not null,
  password_hash text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists classes (
  id text primary key,
  teacher_id text not null references teachers(id) on delete cascade,
  name text not null,
  class_code text not null unique,
  is_open integer not null default 1 check (is_open in (0, 1)),
  max_feedback_rounds integer not null default 2 check (max_feedback_rounds between 1 and 2),
  require_pin integer not null default 1 check (require_pin in (0, 1)),
  school_level text not null default 'middle' check (school_level in ('middle', 'high')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists classes_teacher_idx on classes (teacher_id, created_at);

create table if not exists students (
  id text primary key,
  class_id text not null references classes(id) on delete cascade,
  number integer not null check (number between 1 and 99),
  name text not null,
  pin text check (pin is null or (length(pin) = 4 and pin not glob '*[^0-9]*')),
  failed_logins integer not null default 0,
  locked_until text,
  concern_reviewed_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (class_id, number)
);

create table if not exists mandalarts (
  id text primary key,
  student_id text not null unique references students(id) on delete cascade,
  content text not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at text,
  revision integer not null default 0,
  rule_concern_kind text check (rule_concern_kind in ('self_harm', 'abuse', 'bullying', 'eating', 'violence', 'other')),
  rule_concern_at text,
  rule_concern_current integer not null default 0 check (rule_concern_current in (0, 1)),
  feedback_pending_until text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table if not exists feedback_rounds (
  id text primary key,
  mandalart_id text not null references mandalarts(id) on delete cascade,
  round_no integer not null,
  stage text not null check (stage in ('core', 'block', 'whole')),
  block_index integer check (block_index between 0 and 7),
  attempt integer not null default 1 check (attempt between 1 and 2),
  content_snapshot text not null,
  diagnosis text not null,
  model text,
  concern integer not null default 0 check (concern in (0, 1)),
  concern_kind text check (concern_kind in ('self_harm', 'abuse', 'bullying', 'eating', 'violence', 'other')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (mandalart_id, round_no),
  check ((stage = 'block') = (block_index is not null))
);
create index if not exists feedback_rounds_concern_idx on feedback_rounds (mandalart_id, created_at) where concern = 1;

create table if not exists feedback_cards (
  id text primary key,
  round_id text not null references feedback_rounds(id) on delete cascade,
  position integer not null,
  category text not null,
  target text not null,
  body text not null,
  kind text not null default 'issue' check (kind in ('issue', 'resolved', 'unresolved')),
  prev_card_id text references feedback_cards(id) on delete set null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (round_id, position)
);
create index if not exists feedback_cards_prev_idx on feedback_cards (prev_card_id) where prev_card_id is not null;

create table if not exists feedback_responses (
  id integer primary key autoincrement,
  card_id text not null references feedback_cards(id) on delete cascade,
  action text not null check (action in ('accept', 'reject')),
  reason_code text check (reason_code in ('already_ok', 'not_my_goal', 'dont_understand', 'other_way', 'other')),
  reason_text text check (reason_text is null or length(reason_text) <= 100),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  check (action = 'reject' or (reason_code is null and reason_text is null))
);
create index if not exists feedback_responses_card_idx on feedback_responses (card_id, created_at desc);

create table if not exists event_log (
  id integer primary key autoincrement,
  student_id text references students(id) on delete cascade,
  type text not null,
  payload text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists event_log_student_idx on event_log (student_id, created_at) where student_id is not null;
create index if not exists event_log_type_idx on event_log (type, created_at);
`;
