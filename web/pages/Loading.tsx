import { useEffect, useState } from "react";

// 화면 코드나 데이터를 처음 받는 동안. 금방 끝나면 깜빡이지 않게 0.3초 뒤에야 글자를 보여 줍니다.
export default function Loading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-12" aria-busy="true">
      <p role="status" className={`text-center text-sm text-stone-500 transition-opacity ${show ? "opacity-100" : "opacity-0"}`}>
        불러오는 중…
      </p>
    </main>
  );
}
