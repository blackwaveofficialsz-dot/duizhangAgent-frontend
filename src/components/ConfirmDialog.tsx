import { Button, Modal } from 'antd';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open
      centered
      closable={false}
      footer={null}
      getContainer={false}
      mask={{ closable: false }}
      width={320}
      zIndex={1000}
      onCancel={loading ? undefined : onCancel}
      styles={{ container: { padding: 24, borderRadius: 12 }, body: { padding: 0 } }}
    >
      <div className="space-y-4">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        <div className="text-sm text-slate-600">{message}</div>
        <div className="flex justify-end gap-2">
          <Button
            autoInsertSpace={false}
            disabled={loading}
            onClick={onCancel}
            className="h-auto rounded-lg border-slate-200 px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            {cancelLabel}
          </Button>
          <Button
            autoInsertSpace={false}
            type="primary"
            loading={loading}
            onClick={onConfirm}
            className="h-auto rounded-lg bg-blue-500 px-4 py-1.5 text-sm text-white hover:bg-blue-600"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
