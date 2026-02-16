import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <div className="card">
        <h1>Cherkizovo Design Service</h1>
        <p>Доступный шаблон:</p>
        <ul>
          <li>
            <Link href="/t/TPL_vk_post_1">TPL_vk_post_1</Link>
          </li>
        </ul>
      </div>
    </main>
  );
}
