/**
 * The settings-dialog seat this plugin fills.
 *
 * DSH 0.2.1 made `@deepseek-ai/dsh-client-ui-settings` the canonical home of the
 * settings slot contract; its `settings.section` owner share now carries the
 * shell's `close` callback. The contract is imported rather than re-declared here
 * (a second declaration would be a type-identity conflict against the owner's,
 * and a local copy could drift from the shell that actually renders the page).
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
