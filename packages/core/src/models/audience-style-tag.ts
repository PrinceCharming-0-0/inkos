import { z } from "zod";

// Match genre ids: user supplied, stable, and confined to one file name.
export function isSafeAudienceStyleTagId(id: string): boolean {
  return Boolean(id.trim()) && !/[/\\\0]/.test(id) && !id.includes("..");
}

const shortTextList = z.array(z.string().transform((value) => value.trim()))
  .transform((items) => items.filter(Boolean)).optional();

export const AudienceStyleTagSchema = z.object({
  id: z.string().trim().refine(isSafeAudienceStyleTagId),
  name: z.string().trim().min(1),
  kind: z.enum(["audience", "style"]),
  language: z.enum(["zh", "en"]).default("zh"),
  description: z.string().optional(),
  readerExperience: z.string().optional(),
  narrativeStyle: z.string().optional(),
  relationshipAndElements: shortTextList,
  avoidElements: shortTextList,
  creativeBrief: z.string().optional(),
});

export type AudienceStyleTag = z.infer<typeof AudienceStyleTagSchema>;
