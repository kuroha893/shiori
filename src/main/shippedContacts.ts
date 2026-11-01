import { app } from 'electron'
import { join, resolve, sep } from 'node:path'

/** A file of a contact that ships with the app, in resources/contacts/<id>; refuses anything that escapes it. */
export function shippedFile(id: string, rel: string): string {
  const dir = resolve(join(app.getAppPath(), 'resources', 'contacts', id))
  const full = resolve(dir, rel)
  if (!full.startsWith(dir + sep)) throw new Error('path outside the contact folder')
  return full
}
