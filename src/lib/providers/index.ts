// فهرس المزودات — الوصول الموحد للمحوّل المناسب حسب معرّف المزود
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometApiAdapter } from "./cometapi";

export function getAdapter(provider: string): ProviderAdapter | undefined {
  switch (provider) {
    case "kie":
      return kieAdapter;
    case "cometapi":
      return cometApiAdapter;
    default:
      return undefined;
  }
}

export { ProviderError } from "./types";
export type { CheckResult, CreateTaskResult, ProviderAdapter } from "./types";
