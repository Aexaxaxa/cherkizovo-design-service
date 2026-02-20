import { FigmaApiError, figmaFetchJson } from "@/lib/figmaClient";

export { FigmaApiError };

export async function figmaFetch<T>(path: string): Promise<T> {
  return figmaFetchJson<T>(path);
}
