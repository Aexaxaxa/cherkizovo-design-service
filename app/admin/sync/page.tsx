import { notFound } from "next/navigation";
import AdminSyncClient from "./sync-client";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function AdminSyncPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const token = first(params.token).trim();
  const expectedToken = process.env.ADMIN_UI_TOKEN?.trim();

  if (!expectedToken || token !== expectedToken) {
    notFound();
  }

  return <AdminSyncClient token={token} />;
}
