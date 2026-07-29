import { z } from "zod";
import { fromStandardSchema } from "@agent-surface/core";

/** One line per schema: Standard Schema validation + explicit JSON Schema (D20). */
export const zs = <T extends z.ZodType>(schema: T) =>
  fromStandardSchema(schema, { jsonSchema: z.toJSONSchema(schema) });

export const FiltersState = z.object({
  status: z.enum(["all", "online", "offline"]),
  city: z.string().nullable().describe("Exact city name filter, null = all cities"),
});
export type FiltersStateT = z.infer<typeof FiltersState>;

export const FiltersPatch = z
  .object({
    status: z.enum(["all", "online", "offline"]).optional(),
    city: z.string().nullable().optional().describe("Exact city name filter, null = all cities"),
  })
  .describe("Fields omitted are left unchanged");

export const TableState = z.object({
  visibleRows: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(["online", "offline", "disabled"]),
        city: z.string(),
      }),
    )
    .describe("Rows currently rendered under the active filters"),
  selectedIds: z.array(z.string()),
  sorting: z.object({
    by: z.enum(["name", "status", "city"]),
    dir: z.enum(["asc", "desc"]),
  }),
});
export type TableStateT = z.infer<typeof TableState>;

export const SelectRows = z.object({
  ids: z.array(z.string()).min(1).describe("Device ids to select"),
  mode: z.enum(["replace", "add", "remove"]).default("replace"),
});

export const Sort = z.object({
  by: z.enum(["name", "status", "city"]),
  dir: z.enum(["asc", "desc"]),
});
export type SortT = z.infer<typeof Sort>;

export const DrawerState = z.object({
  isOpen: z.boolean(),
  deviceId: z.string().nullable(),
});

export const OpenDrawer = z.object({ deviceId: z.string() });

export const RouteState = z.object({ page: z.enum(["devices", "comparison", "reports"]) });
export const GoTo = z.object({ page: z.enum(["devices", "comparison", "reports"]) });
export type PageT = z.infer<typeof RouteState>["page"];

export const EmptyInput = z.object({});

export const FiltersStateSchema = zs(FiltersState);
export const FiltersPatchSchema = zs(FiltersPatch);
export const TableStateSchema = zs(TableState);
export const SelectRowsSchema = zs(SelectRows);
export const SortSchema = zs(Sort);
export const DrawerStateSchema = zs(DrawerState);
export const OpenDrawerSchema = zs(OpenDrawer);
export const RouteStateSchema = zs(RouteState);
export const GoToSchema = zs(GoTo);
export const EmptyInputSchema = zs(EmptyInput);
