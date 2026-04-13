declare module "akash-sdk-internal-chunk" {
  import type { GeneratedType } from "@cosmjs/proto-signing";
  export function getMessageType(typeUrl: string): GeneratedType | undefined;
}
