import React from 'react';
import { cn } from "@/src/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/src/components/ui/dialog';
import { modalStyles as styles } from './modal.styles';
import {
  ModalProps,
  ModalHeaderProps,
  ModalContentProps,
  ModalFooterProps,
} from './modal.types';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(styles.content, className)}>
        <ModalHeader title={title} description={description} />
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function ModalHeader({ 
  title, 
  description, 
  className 
}: ModalHeaderProps) {
  return (
    <DialogHeader className={cn(styles.header, className)}>
      <DialogTitle className={styles.title}>
        {title}
      </DialogTitle>
      {description && (
        <DialogDescription className={styles.description}>
          {description}
        </DialogDescription>
      )}
    </DialogHeader>
  );
}

export function ModalContent({ 
  children, 
  className 
}: ModalContentProps) {
  return (
    <div className={cn(styles.form, className)}>
      {children}
    </div>
  );
}

export function ModalFooter({ 
  children, 
  className 
}: ModalFooterProps) {
  return (
    <div className={cn(styles.footer, className)}>
      {children}
    </div>
  );
}
