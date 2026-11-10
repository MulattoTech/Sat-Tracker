/**
 * Props for the ChangelogModal component
 */
export interface ChangelogModalProps {
  /**
   * Whether the modal is open
   */
  open: boolean;
  
  /**
   * Callback function to close the modal
   */
  onClose: () => void;
  
  /**
   * Optional version to highlight in the changelog
   * If not provided, the latest version will be highlighted
   */
  version?: string;
}
