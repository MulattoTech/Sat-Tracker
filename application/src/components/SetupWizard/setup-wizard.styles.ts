import { cn } from "@/src/lib/utils";

/**
 * Styles for the SetupWizard component
 * 
 * These styles define the visual appearance of the setup wizard
 */
export const styles = {
  // Container styles
  container: "min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-b from-teal-50 to-white",
  formContainer: "w-full max-w-md bg-white rounded-xl shadow-lg p-6 mb-8",
  
  // Header styles
  headerContainer: "flex flex-col items-center mb-6",
  logo: "mb-4",
  title: "text-2xl font-bold text-teal-700",
  progressBar: "w-full bg-gray-200 h-1 my-4 rounded-full",
  progressIndicator: "bg-teal-500 h-1 rounded-full transition-all duration-300",
  stepIndicator: "text-sm text-gray-500",
  
  // Stage container
  stageContainer: "space-y-6",
  stageTitle: "text-xl font-semibold text-gray-800",
  stageDescription: "text-gray-600",
  stageImage: "mx-auto mb-6 drop-shadow-[0_3px_3px_rgba(0,0,0,0.7)]", // XXL drop shadow
  
  // Form elements
  formGroup: "space-y-4",
  formLabel: "block text-sm font-medium text-gray-700 mb-1",
  formInput: "w-full",
  formSelect: "w-full",
  formRadioGroup: "flex items-center space-x-2",
  formRadio: "h-4 w-4 text-teal-600 focus:ring-teal-500",
  formRadioLabel: "text-sm font-medium text-gray-700",
  formHelperText: "text-xs text-gray-500 mt-1",
  formWarningText: "text-xs text-amber-600 mt-1",
  
  // Security setup specific
  securityOptionsContainer: "space-y-2",
  securityOption: "flex items-center space-x-2",
  securityPinContainer: "space-y-4 pt-2",
  
  // Caretaker specific
  caretakerContainer: "border-b border-gray-200 pb-4",
  caretakerTitle: "text-md font-medium text-gray-800 mb-2",
  caretakerGrid: "grid grid-cols-2 gap-3 mb-3",
  caretakerList: "space-y-2",
  caretakerItem: "flex justify-between items-center bg-gray-50 p-2 rounded",
  caretakerName: "font-medium",
  caretakerInfo: "text-xs text-gray-500 ml-2",
  
  // Baby setup specific
  babyFormGrid: "grid grid-cols-2 gap-3",
  datePickerButton: "w-full justify-start text-left font-normal",
  datePickerPlaceholder: "text-gray-400",
  
  // Error message
  errorContainer: "mt-4 p-2 bg-red-50 border border-red-200 rounded text-red-600 text-sm",
  
  // Navigation buttons
  navigationContainer: "flex justify-between mt-8",
  previousButton: "px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500",
  nextButton: "px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-teal-600 hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500"
};
