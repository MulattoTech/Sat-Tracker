# Activity Form Components

This document provides guidelines for creating and configuring activity form components in the Baby Tracker application. Activity forms are used to record various baby activities such as feeding, diaper changes, sleep, and notes.

## Common Form Structure

All activity forms in the application follow a consistent structure and pattern:

1. **Form Container**: A modal or dialog that contains the form
2. **Form Fields**: Input fields specific to the activity type
3. **Form Controls**: Buttons for submitting or canceling the form

## Component Architecture

### Props Interface

All activity forms should accept the following standard props:

```typescript
interface ActivityFormProps {
  isOpen: boolean;                // Controls whether the form is visible
  onClose: () => void;            // Function to call when the form should be closed
  babyId: string | undefined;     // ID of the baby for whom the activity is being recorded
  initialTime: string;            // Initial time value for the form (ISO format)
  activity?: ActivityResponse;    // Existing activity data (for edit mode)
  onSuccess?: () => void;         // Optional callback function called after successful submission
}
```

### State Management

Each form should manage the following state:

```typescript
// Form data state
const [formData, setFormData] = useState({
  time: initialTime,
  // Additional fields specific to the activity type
});

// Loading state for API calls
const [loading, setLoading] = useState(false);

// Initialization flag to prevent form reset when initialTime changes
const [isInitialized, setIsInitialized] = useState(false);
```

### Initialization Pattern

To prevent form resets when the `initialTime` prop changes (which may happen every minute if it's based on the current time), use the following initialization pattern:

```typescript
useEffect(() => {
  if (isOpen && !isInitialized) {
    if (activity) {
      // Editing mode - populate with activity data
      setFormData({
        time: formatDateForInput(initialTime),
        // Additional fields from activity
      });
    } else {
      // New entry mode
      setFormData(prev => ({
        ...prev,
        time: formatDateForInput(initialTime)
      }));
      
      // Additional initialization logic specific to the activity type
    }
    
    // Mark as initialized
    setIsInitialized(true);
  } else if (!isOpen) {
    // Reset initialization flag when form closes
    setIsInitialized(false);
  }
}, [isOpen, initialTime, activity, isInitialized]);
```

### Date Formatting

Use a consistent date formatting function across all forms:

```typescript
const formatDateForInput = (dateStr: string) => {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  
  // Format as YYYY-MM-DDThh:mm in local time
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};
```

### Form Submission

Implement a consistent form submission pattern:

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!babyId) return;

  // Validate required fields
  if (!formData.requiredField || !formData.time) {
    console.error('Required fields missing');
    return;
  }

  setLoading(true);

  try {
    const payload = {
      babyId,
      time: formData.time,
      // Additional fields specific to the activity type
    };

    // Get auth token from localStorage
    const authToken = localStorage.getItem('authToken');

    const response = await fetch(`/api/activity-endpoint${activity ? `?id=${activity.id}` : ''}`, {
      method: activity ? 'PUT' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authToken ? `Bearer ${authToken}` : '',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error('Failed to save activity');
    }

    onClose();
    onSuccess?.();
    
    // Reset form data
    setFormData({
      time: initialTime,
      // Reset additional fields
    });
  } catch (error) {
    console.error('Error saving activity:', error);
  } finally {
    setLoading(false);
  }
};
```

## UI Components

Use the following UI components consistently across all forms:

1. **FormPage**: The container component for the form
2. **FormPageContent**: The content area of the form
3. **FormPageFooter**: The footer area with action buttons
4. **Input**: For text and date inputs
5. **Select**: For dropdown selections
6. **Button**: For form actions

Example:

```tsx
return (
  <FormPage
    isOpen={isOpen}
    onClose={onClose}
    title={activity ? 'Edit Activity' : 'Log Activity'}
    description={activity ? 'Update activity details' : 'Record a new activity'}
  >
    <form onSubmit={handleSubmit}>
      <FormPageContent>
        {/* Form fields */}
      </FormPageContent>
      <FormPageFooter>
        <div className="flex justify-end space-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {activity ? 'Update' : 'Save'}
          </Button>
        </div>
      </FormPageFooter>
    </form>
  </FormPage>
);
```

## Adding a New Activity Form

To add a new activity form:

1. Create a new folder in `src/components/forms/` with the name of the activity (e.g., `NewActivityForm/`)
2. Create an `index.tsx` file in the folder with the form component
3. Create a `README.md` file in the folder documenting the component
4. Implement the form following the patterns described in this document
5. Add the form to the appropriate parent component

### Example Folder Structure

```
src/components/forms/
├── NewActivityForm/
│   ├── index.tsx
│   └── README.md
```

## Best Practices

1. **Modular Design**: Break down complex forms into subcomponents
2. **Consistent Validation**: Validate all required fields before submission
3. **Error Handling**: Provide clear error messages for API failures
4. **Loading States**: Disable form controls during API calls
5. **Responsive Design**: Ensure forms work well on all device sizes
6. **Accessibility**: Include proper labels and ARIA attributes
7. **Initialization Flag**: Use the initialization flag pattern to prevent form resets
8. **Documentation**: Document the component in a README.md file

## Common Issues and Solutions

### Form Resets When initialTime Changes

**Problem**: The form resets to initial values when the `initialTime` prop changes (which may happen every minute if it's based on the current time).

**Solution**: Implement the initialization flag pattern as described above. This ensures the form is only initialized once when it opens, and not on subsequent prop changes.

### Time Zone Handling

**Problem**: Date and time values may be inconsistent across different time zones.

**Solution**: Always use the `formatDateForInput` function to format dates for input fields, and ensure the API handles time zone conversion properly.

### Form Validation

**Problem**: Form submission with missing required fields.

**Solution**: Implement validation checks before submission and provide clear error messages to the user.
