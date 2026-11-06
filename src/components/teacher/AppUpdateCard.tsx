import { Suspense } from "react";
import pkg from "../../../package.json";
import { UPDATE_WORKFLOW_YML } from "@/lib/update-workflow-yml";
import {
  MANUAL_INSTALL_DOCS_URL, UPDATE_DOCS_URL, UPSTREAM_WORKFLOW_RAW_URL, WORKFLOW_PATH, fetchLatestVersion, installWorkflowUrl, isNewerVersion,
  repoFromEnv, runWorkflowUrl, subjectParticle, type GitRepo,
} from "@/lib/app-update";

// 교사 화면 아래쪽의 '앱 업데이트' 카드(서버 컴포넌트).
// Deploy 버튼이 만든 교사 사본에는 .github/workflows가 없어서 Actions 탭에 '앱 업데이트'가 처음엔 없습니다.
// ① '업데이트 기능 설치 (처음 한 번)': GitHub 새 파일 화면을 workflow 내용으로 채워 엽니다.
// ② '업데이트 받기': Actions의 '앱 업데이트' 화면(Run workflow)을 엽니다.
// 원본의 새 버전 확인은 Suspense 안에서 따로 기다리므로 화면을 늦추지 않고, 실패하면 아무것도 보여 주지 않습니다.
// 기다리는 동안에는 펼칠 수 없는 제목 줄(CardHead)만 보여 줍니다. 여기에 펼칠 수 있는 카드를 두면 교사가 펼친 카드가
// 확인이 끝나 카드가 바뀔 때 다시 접히고, 긴 설치 링크도 HTML에 두 번 들어갑니다.
export default function AppUpdate() {
  const current = pkg.version;
  const repo = repoFromEnv(process.env);
  return (
    <Suspense fallback={<CardHead current={current} />}>
      <AppUpdateWithLatest current={current} repo={repo} />
    </Suspense>
  );
}

async function AppUpdateWithLatest({ current, repo }: { current: string; repo: GitRepo | null }) {
  const latest = await fetchLatestVersion();
  return <AppUpdateCard current={current} latest={latest && isNewerVersion(latest, current) ? latest : null} repo={repo} />;
}

const cardBox = "rounded-xl border border-stone-300 bg-white text-sm print:hidden";
const headRow = "flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3";
const linkBtn = "self-start rounded-lg border border-stone-400 bg-white px-3 py-1.5 text-sm font-semibold hover:bg-stone-50";
const extLink = "text-sky-700 underline";

function Title({ current }: { current: string }) {
  return (
    <>
      <span className="font-bold">앱 업데이트</span>
      <span className="text-xs text-stone-500">지금 버전 {current}</span>
    </>
  );
}

function CardHead({ current }: { current: string }) {
  return (
    <div className={cardBox}>
      <div className={headRow}>
        <Title current={current} />
      </div>
    </div>
  );
}

function AppUpdateCard({ current, latest, repo }: { current: string; latest: string | null; repo: GitRepo | null }) {
  return (
    // 새 버전이 있을 때만 처음부터 펼쳐 둡니다.
    <details open={!!latest} className={`group ${cardBox}`}>
      <summary className={`${headRow} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        <Title current={current} />
        {latest && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
            새 버전 {latest}{subjectParticle(latest)} 있어요
          </span>
        )}
        <span className="ml-auto text-xs text-sky-700 group-open:hidden">방법 보기 ▾</span>
        <span className="ml-auto hidden text-xs text-sky-700 group-open:inline">접기 ▴</span>
      </summary>

      <div className="flex flex-col gap-3 border-t border-stone-200 px-4 py-3">
        {repo ? <RepoSteps repo={repo} /> : <ManualSteps />}
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950">
          수업 중에는 하지 마세요. 업데이트 전부터 열려 있던 학생 화면은 저장을 멈출 수 있습니다. 수업이 없는 시간에 하세요.
        </p>
        <p className="text-xs text-stone-500">
          자세한 방법:{" "}
          <a href={UPDATE_DOCS_URL} target="_blank" rel="noopener noreferrer" className={extLink}>설치 안내 5. 앱 업데이트 받기</a>
        </p>
      </div>
    </details>
  );
}

function RepoSteps({ repo }: { repo: GitRepo }) {
  return (
    <>
      <p className="text-xs text-stone-500">
        저장소 <code className="break-all font-mono">{repo.owner}/{repo.repo}</code> · GitHub에 이 저장소의 계정으로 로그인한 채로 누르세요.
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold text-stone-500">① 처음 한 번만</p>
        <a href={installWorkflowUrl(repo, UPDATE_WORKFLOW_YML)} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          업데이트 기능 설치 (처음 한 번)
        </a>
        <p className="text-xs text-stone-600">
          GitHub의 새 파일 화면이 열리고 내용이 미리 채워져 있습니다. 오른쪽 위 초록 ‘Commit changes…’를 누르고, 나온 창의 초록 ‘Commit changes’를 한 번 더 누르면 끝입니다.
          편집 칸이 비어 있으면 <a href={MANUAL_INSTALL_DOCS_URL} target="_blank" rel="noopener noreferrer" className={extLink}>직접 넣는 방법</a>을 보세요.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold text-stone-500">② 업데이트할 때마다</p>
        <a href={runWorkflowUrl(repo)} target="_blank" rel="noopener noreferrer" className={linkBtn}>
          업데이트 받기
        </a>
        <p className="text-xs text-stone-600">
          열린 화면 오른쪽의 ‘Run workflow’를 누르고, 작은 창의 초록 ‘Run workflow’를 한 번 더 누르세요. 몇 분 뒤 Vercel이 새 버전으로 다시 배포합니다.
          GitHub에 ‘404’ 화면이 나오면 ①을 먼저 하세요.
        </p>
      </div>
    </>
  );
}

function ManualSteps() {
  return (
    <>
      <p className="text-xs text-stone-500">이 화면에서 GitHub 저장소를 알아내지 못해 버튼 대신 방법을 적었습니다.</p>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold text-stone-500">① 처음 한 번만</p>
        <p className="text-xs text-stone-600">
          GitHub에서 내 저장소(예: 내아이디/mandalart)를 열고 <b>Add file</b> → <b>Create new file</b> 을 누른 뒤 두 칸을 채웁니다.
        </p>
        <ul className="ml-4 list-disc text-xs text-stone-600">
          <li>파일 이름 칸: <code className="break-all font-mono">{WORKFLOW_PATH}</code></li>
          <li>
            편집 칸: <a href={UPSTREAM_WORKFLOW_RAW_URL} target="_blank" rel="noopener noreferrer" className={extLink}>이 파일의 내용</a>을 모두 복사해 붙여 넣기
          </li>
        </ul>
        <p className="text-xs text-stone-600">그다음 초록 ‘Commit changes…’ → ‘Commit changes’를 누릅니다.</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold text-stone-500">② 업데이트할 때마다</p>
        <p className="text-xs text-stone-600">
          내 저장소의 <b>Actions</b> 탭 → 왼쪽 <b>앱 업데이트</b> → <b>Run workflow</b> → 초록 <b>Run workflow</b> 를 누릅니다. 몇 분 뒤 Vercel이 새 버전으로 다시 배포합니다.
        </p>
      </div>
    </>
  );
}
