import React from 'react'
import { Button, Modal, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

export function SettingsDialog({ title, close, actions, children }) {
  return <Modal open title={title} headless className="apple-sync-review" onClose={close}>
    <header className="apple-sync-review-header"><h2>{title}</h2>
      <Button variant="ghost" size="sm" aria-label="关闭窗口" onClick={close}><IconCloseOutlineRegular size={18} /></Button>
    </header>
    <div className="apple-sync-review-body">{children}</div>
    <footer className="apple-sync-review-footer"><div>
      {actions ? <><Button variant="outline" onClick={close}>取消</Button>{actions}</> : <Button variant="outline" onClick={close}>关闭</Button>}
    </div></footer>
  </Modal>
}
