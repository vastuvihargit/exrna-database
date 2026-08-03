import { z } from 'zod';

const folderEntry = z.object({
  key: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300).optional(),
});

export const saveFolderTemplatesSchema = z
  .object({
    project: z.array(folderEntry).min(1).max(40).optional(),
    department: z.array(folderEntry).min(1).max(40).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/**
 * `fieldKeys` is only shape-checked here. Whether a key names a real research field is
 * decided in the service against the metadata allow-list — a `z.string()` would happily
 * accept `$where`, and these keys become dotted paths under `File.metadata`.
 */
export const saveMetadataTemplatesSchema = z.object({
  templates: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1).max(80),
        description: z.string().trim().max(300).optional(),
        fieldKeys: z.array(z.string().trim().min(1).max(60)).min(1).max(30),
        recommendedKeys: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
      }),
    )
    .min(1)
    .max(25),
});
