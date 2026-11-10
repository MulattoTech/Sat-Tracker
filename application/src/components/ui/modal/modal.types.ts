import { ReactNode } from 'react';

export interface ModalProps {
  /** Whether the modal is currently open */
  open: boolean;
  /** Callback when the modal should close */
  onOpenChange: (open: boolean) => void;
  /** Title of the modal */
  title: string;
  /** Optional description below the title */
  description?: string;
  /** Content of the modal */
  children: ReactNode;
  /** Additional CSS classes for the modal content */
  className?: string;
}

export interface ModalHeaderProps {
  /** Title of the modal */
  title: string;
  /** Optional description below the title */
  description?: string;
  /** Additional CSS classes for the header */
  className?: string;
}

export interface ModalContentProps {
  /** Content of the modal */
  children: ReactNode;
  /** Additional CSS classes */
  className?: string;
}

export interface ModalFooterProps {
  /** Content of the footer */
  children: ReactNode;
  /** Additional CSS classes */
  className?: string;
}
