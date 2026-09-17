/**
 * Shared tool-name prettifier. Three renderings need it:
 *
 *   1. The tool call card header (`ToolCallItem`) — small pill per completed call.
 *   2. The live status line during a stream — "Creating scene..." while running.
 *   3. The reasoning/thinking block — CC narrates tool names inline as
 *      `mcp__dreambyte__create_scene` and those leak into user-visible text.
 *
 * Keeping the helpers here so every site agrees on the display string.
 */

/**
 * `mcp__dreambyte__create_scene` → `create_scene`. In the in-app agent
 * path tool names arrive bare; in Claude Code / Codex CLI they arrive wrapped
 * in the MCP protocol prefix. Strip the wrapper so downstream logic can
 * compare against the canonical name.
 */
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '')
}

/** Friendly display labels for the common tools. Keep in sync with the map in
 *  `ToolCallItem.tsx` — the duplication is intentional so this file has no
 *  runtime dep on the React component tree. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  add_layer: 'Creating layer',
  add_canvas_layer: 'Creating canvas animation',
  add_svg_layer: 'Creating SVG graphic',
  add_three_layer: 'Creating 3D scene',
  add_d3_layer: 'Creating data visualization',
  add_lottie_layer: 'Adding Lottie animation',
  add_zdog_layer: 'Creating Zdog illustration',
  regenerate_layer: 'Regenerating layer',
  edit_layer: 'Editing layer',
  patch_layer_code: 'Patching layer code',
  delete_layer: 'Deleting layer',
  rename_scene: 'Renaming scene',
  add_scene: 'Adding scene',
  create_scene: 'Creating scene',
  delete_scene: 'Deleting scene',
  reorder_scenes: 'Reordering scenes',
  read_scene: 'Reading scene',
  inspect: 'Reading project state',
  write_scene_code: 'Writing scene code',
  update_global_style: 'Updating global style',
  set_style: 'Setting style',
  design_brief: 'Design brief',
  character: 'Character',
  interaction: 'Adding interactions',
  edit_interaction: 'Editing interaction',
  remove_interaction: 'Removing interaction',
  generate_image: 'Generating image',
  generate_audio: 'Generating audio',
  generate_video: 'Generating video clip',
  generate_avatar_narration: 'Adding avatar narrator',
  generate_avatar_scene: 'Creating avatar scene',
  chart: 'Working on a chart',
  add_narration: 'Adding narration',
  add_sfx: 'Adding sound effect',
  add_music: 'Adding music',
  verify_scene: 'Verifying scene',
  plan_scenes: 'Planning scenes',
  scene_props: 'Updating scene',
  search_web: 'Searching the web',
  read_url: 'Reading URL',
  web_search: 'Searching the web',
  fetch_url_content: 'Reading article',
  find_media: 'Finding media',
  fetch_video_from_url: 'Downloading video',
  media_library: 'Media library',
  connect_scenes: 'Connecting scenes',
  define_scene_variable: 'Defining variable',
  set_media_layer: 'Setting media layer',
  capture_frame: 'Capturing frame',
  get_world_state: 'Reading world state',
  refresh_state: 'Refreshing state',
  list_scenes: 'Listing scenes',
  select_project: 'Selecting project',
}

/** Humanize a snake_case tool name as a fallback: `write_scene_code` → `Write
 *  scene code`. Strips MCP prefix first. */
function humanize(name: string): string {
  const bare = stripMcpPrefix(name)
  const words = bare.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The display label for a tool name from either path. Looks up the canonical
 *  map first, falls back to humanize() for tools the map doesn't list. */
export function prettyToolLabel(name: string): string {
  const bare = stripMcpPrefix(name)
  return TOOL_DISPLAY_NAMES[bare] ?? humanize(name)
}

/**
 * Post-process a blob of model-generated text (e.g. CC's extended thinking)
 * and replace every `mcp__dreambyte__<tool>` token with its pretty label.
 * Keeps the surrounding prose intact.
 *
 * Matches `mcp__<server>__<tool_name>` where the tool name is word chars
 * (letters, digits, underscores). Tight enough not to eat adjacent
 * punctuation or word runs.
 */
const MCP_NAME_PATTERN = /mcp__[a-zA-Z0-9-]+__([a-z0-9_]+)/g
export function prettifyMcpNamesInText(text: string): string {
  return text.replace(MCP_NAME_PATTERN, (_match, toolName: string) => prettyToolLabel(toolName))
}
