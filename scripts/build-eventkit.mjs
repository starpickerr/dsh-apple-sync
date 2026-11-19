import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cp } from 'node:fs/promises'

if (process.platform === 'darwin') {
  const directory = fileURLToPath(new URL('../python/apple_sync/', import.meta.url))
  const source = join(directory, 'native')
  const temporary = await mkdtemp(join(tmpdir(), 'alcor-eventkit-build-'))
  const app = join(temporary, 'Alcor Apple Sync.app')
  const executable = join(app, 'Contents/MacOS/AlcorCalendarBridge')
  const helpers = ['OccurrenceIdentity.swift', 'ScanWindows.swift', 'ReminderBridge.swift', 'ReminderFields.swift']
  try {
    // Compile one stable snapshot outside the synced workspace.
    for (const name of ['Info.plist', ...helpers]) await copyFile(join(source, name), join(temporary, name))
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
    await copyFile(join(temporary, 'Info.plist'), join(app, 'Contents/Info.plist'))
    await copyFile(join(source, 'CalendarBridge.swift'), join(temporary, 'main.swift'))
    execFileSync('/usr/bin/swiftc', ['-O', '-framework', 'EventKit',
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', join(temporary, 'Info.plist'),
      join(temporary, 'main.swift'), ...helpers.map(name => join(temporary, name)),
      '-o', executable], { stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Library/Developer/CommandLineTools' } })
    execFileSync('/usr/bin/xattr', ['-cr', app])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', app])
    const destination = join(directory, 'Alcor Apple Sync.app')
    await rm(destination, { recursive: true, force: true })
    await cp(app, destination, { recursive: true })
    const confirm = join(temporary, 'AlcorConfirm')
    const confirmSource = fileURLToPath(new URL('../../Alcor/packages/alcor-secretary/native/Confirm.swift', import.meta.url))
    execFileSync('/usr/bin/swiftc', ['-O', confirmSource, '-o', confirm], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', confirm], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', confirm])
    const confirmDirectory = fileURLToPath(new URL('../native/', import.meta.url))
    await mkdir(confirmDirectory, { recursive: true })
    await copyFile(confirm, join(confirmDirectory, 'AlcorConfirm'))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
