'use client';

import React, { useState, useEffect, useRef } from 'react';
import { PumpLogCreate, PumpLogResponse } from '@/app/api/types';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Textarea } from '@/src/components/ui/textarea';
import { Label } from '@/src/components/ui/label';
import { DateTimePicker } from '@/src/components/ui/date-time-picker';
import {
  FormPage, 
  FormPageContent, 
  FormPageFooter 
} from '@/src/components/ui/form-page';
import { useTimezone } from '@/app/context/timezone';
import { useToast } from '@/src/components/ui/toast';
import { handleExpirationError } from '@/src/lib/expiration-error-handler';
import { Plus, Minus } from 'lucide-react';
import { Switch } from '@/src/components/ui/switch';
import { useLocalization } from '@/src/context/localization';
import { BreastMilkAdjustmentResponse } from '@/app/api/types';
import { useUnit } from '@/src/hooks/useUnit';
import { cacheDefaultBottleUnit, readCachedDefaultBottleUnit } from '@/src/utils/defaultBottleUnit';
import { isPumpAction, PUMP_ACTIONS, PumpAction, pumpActionLabel } from '@/src/utils/pumpAction';
import { changedPumpFields } from '@/src/utils/pumpFormUpdate';
import { isPumpRevision } from '@/src/utils/pumpRevision';
import { PumpConflictReview } from './PumpConflictReview';

import './pump-form.css';


interface PumpFormProps {
  isOpen: boolean;
  onClose: () => void;
  babyId: string | undefined;
  initialTime: string;
  activity?: PumpLogResponse;
  adjustmentActivity?: BreastMilkAdjustmentResponse;
  onSuccess?: () => void;
}

export default function PumpForm({
  isOpen,
  onClose,
  babyId,
  initialTime,
  activity,
  adjustmentActivity,
  onSuccess,
}: PumpFormProps) {
  const { t } = useLocalization();
  const { unitSymbol } = useUnit();
  const { toUTCString } = useTimezone();
  const { showToast } = useToast();

  // Adjustment mode state
  const [isAdjustMode, setIsAdjustMode] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustUnit, setAdjustUnit] = useState<string>(() => readCachedDefaultBottleUnit());
  const [adjustIsAdding, setAdjustIsAdding] = useState(true);
  const [adjustReason, setAdjustReason] = useState('Initial Stock');
  const [adjustNotes, setAdjustNotes] = useState('');

  // Pump action state
  const [pumpAction, setPumpAction] = useState<PumpAction>('STORED');
  const [editedTimes, setEditedTimes] = useState({ start: false, end: false });
  const [selectedStartDateTime, setSelectedStartDateTime] = useState<Date>(() => {
    try {
      // Initialize with current time - 15 minutes as default (start time is in the past)
      const date = new Date(initialTime);
      date.setMinutes(date.getMinutes() - 15);
      // Check if the date is valid
      if (isNaN(date.getTime())) {
        const now = new Date();
        now.setMinutes(now.getMinutes() - 15);
        return now; // Fallback to current date - 15 min if invalid
      }
      return date;
    } catch (error) {
      console.error('Error parsing initialTime:', error);
      const now = new Date();
      now.setMinutes(now.getMinutes() - 15);
      return now; // Fallback to current date - 15 min
    }
  });
  
  const [selectedEndDateTime, setSelectedEndDateTime] = useState<Date>(() => {
    try {
      // Initialize with current time as default (end time is now)
      const date = new Date(initialTime);
      // Check if the date is valid
      if (isNaN(date.getTime())) {
        return new Date(); // Fallback to current date if invalid
      }
      return date;
    } catch (error) {
      console.error('Error setting initial end time:', error);
      return new Date(); // Fallback to current date
    }
  });
  
  const [formData, setFormData] = useState({
    startTime: initialTime,
    endTime: '',
    leftAmount: '',
    rightAmount: '',
    totalAmount: '',
    unitAbbr: readCachedDefaultBottleUnit() as string,
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [initializedTime, setInitializedTime] = useState<string | null>(null);
  const [breastMilkTrackingEnabled, setBreastMilkTrackingEnabled] = useState(true);
  const [editBaseline, setEditBaseline] = useState<PumpLogResponse | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [reconciliationError, setReconciliationError] = useState('');
  const [latestPump, setLatestPump] = useState<PumpLogResponse | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [latestError, setLatestError] = useState('');
  const editEpoch = useRef(0);
  useEffect(() => () => { editEpoch.current += 1; }, []);

  const populatePumpFields = (record: PumpLogResponse) => {
    // Set pump action from activity
    setPumpAction(isPumpAction(record.pumpAction) ? record.pumpAction : 'UNKNOWN');
    // Editing mode - populate with activity data
    try {
      // Set the start date time
      const startDate = new Date(record.startTime);
      if (!isNaN(startDate.getTime())) {
        setSelectedStartDateTime(startDate);
      }

      // Set the end date time if it exists
      if (record.endTime) {
        const endDate = new Date(record.endTime);
        if (!isNaN(endDate.getTime())) {
          setSelectedEndDateTime(endDate);
        }
      }
    } catch (error) {
      console.error('Error parsing activity times:', error);
    }

    // Format the start date for the time property
    const startDate = new Date(record.startTime);
    const startYear = startDate.getFullYear();
    const startMonth = String(startDate.getMonth() + 1).padStart(2, '0');
    const startDay = String(startDate.getDate()).padStart(2, '0');
    const startHours = String(startDate.getHours()).padStart(2, '0');
    const startMinutes = String(startDate.getMinutes()).padStart(2, '0');
    const formattedStartTime = `${startYear}-${startMonth}-${startDay}T${startHours}:${startMinutes}`;

    // Format the end date for the time property if it exists
    let formattedEndTime = '';
    if (record.endTime) {
      const endDate = new Date(record.endTime);
      const endYear = endDate.getFullYear();
      const endMonth = String(endDate.getMonth() + 1).padStart(2, '0');
      const endDay = String(endDate.getDate()).padStart(2, '0');
      const endHours = String(endDate.getHours()).padStart(2, '0');
      const endMinutes = String(endDate.getMinutes()).padStart(2, '0');
      formattedEndTime = `${endYear}-${endMonth}-${endDay}T${endHours}:${endMinutes}`;
    }

    setFormData({
      startTime: formattedStartTime,
      endTime: formattedEndTime,
      leftAmount: record.leftAmount?.toString() || '',
      rightAmount: record.rightAmount?.toString() || '',
      totalAmount: record.totalAmount?.toString() || '',
      unitAbbr: record.unitAbbr || readCachedDefaultBottleUnit(),
      notes: record.notes || '',
    });
    setEditedTimes({ start: false, end: false });
  };

  // Handle start date/time change
  const handleStartDateTimeChange = (date: Date) => {
    setEditedTimes(previous => ({ ...previous, start: true }));
    setSelectedStartDateTime(date);
    
    // Also update the time in formData for compatibility with existing code
    // Format the date as ISO string for storage in formData
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    const formattedTime = `${year}-${month}-${day}T${hours}:${minutes}`;
    setFormData(prev => ({ ...prev, startTime: formattedTime }));
  };
  
  // Handle end date/time change
  const handleEndDateTimeChange = (date: Date) => {
    setEditedTimes(previous => ({ ...previous, end: true }));
    setSelectedEndDateTime(date);
    
    // Format the date as ISO string for storage in formData
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    const formattedTime = `${year}-${month}-${day}T${hours}:${minutes}`;
    setFormData(prev => ({ ...prev, endTime: formattedTime }));
  };

  // Initialize adjustment mode when editing an adjustment
  useEffect(() => {
    if (isOpen && adjustmentActivity) {
      setIsAdjustMode(true);
      setAdjustAmount(Math.abs(adjustmentActivity.amount).toString());
      setAdjustUnit(adjustmentActivity.unitAbbr || readCachedDefaultBottleUnit());
      setAdjustIsAdding(adjustmentActivity.amount >= 0);
      setAdjustReason(adjustmentActivity.reason || 'Other');
      setAdjustNotes(adjustmentActivity.notes || '');
    } else if (isOpen && !adjustmentActivity) {
      setIsAdjustMode(false);
    }
  }, [isOpen, adjustmentActivity]);

  useEffect(() => {
    if (isOpen && !isInitialized) {
      editEpoch.current += 1;
      if (activity) {
        setEditBaseline({ ...activity });
        populatePumpFields(activity);
      } else {
        // New entry mode - fetch default unit from settings
        const fetchDefaultUnit = async () => {
          try {
            const authToken = localStorage.getItem('authToken');
            const response = await fetch('/api/settings', {
              cache: 'no-store',
              headers: {
                'Authorization': authToken ? `Bearer ${authToken}` : '',
              },
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data.success && data.data) {
              const defaultBottleUnit = cacheDefaultBottleUnit(data.data.defaultBottleUnit);
              if (defaultBottleUnit) {
                setFormData(prev => ({ ...prev, unitAbbr: defaultBottleUnit }));
                // Only seed the adjustment unit for new entries — when editing an
                // existing adjustment its stored unit must be preserved.
                if (!adjustmentActivity) {
                  setAdjustUnit(defaultBottleUnit);
                }
              }
            }
            setBreastMilkTrackingEnabled(data.data?.enableBreastMilkTracking ?? true);
          } catch (error) {
            console.error('Error fetching settings:', error);
          }
        };
        fetchDefaultUnit();

        // Initialize from initialTime prop
        try {
          const date = new Date(initialTime);
          if (!isNaN(date.getTime())) {
            // Set start time to 15 minutes in the past
            const startDate = new Date(date);
            startDate.setMinutes(startDate.getMinutes() - 15);
            setSelectedStartDateTime(startDate);
            
            // Set end time to current time
            setSelectedEndDateTime(date);
            
            // Also update the times in formData
            const startYear = startDate.getFullYear();
            const startMonth = String(startDate.getMonth() + 1).padStart(2, '0');
            const startDay = String(startDate.getDate()).padStart(2, '0');
            const startHours = String(startDate.getHours()).padStart(2, '0');
            const startMinutes = String(startDate.getMinutes()).padStart(2, '0');
            const formattedStartTime = `${startYear}-${startMonth}-${startDay}T${startHours}:${startMinutes}`;
            
            const endYear = date.getFullYear();
            const endMonth = String(date.getMonth() + 1).padStart(2, '0');
            const endDay = String(date.getDate()).padStart(2, '0');
            const endHours = String(date.getHours()).padStart(2, '0');
            const endMinutes = String(date.getMinutes()).padStart(2, '0');
            const formattedEndTime = `${endYear}-${endMonth}-${endDay}T${endHours}:${endMinutes}`;
            
            setFormData(prev => ({ 
              ...prev, 
              startTime: formattedStartTime,
              endTime: formattedEndTime
            }));
          }
        } catch (error) {
          console.error('Error parsing initialTime:', error);
        }
        
        // Store the initial time used for new entry
        setInitializedTime(initialTime);
      }
      
      // Mark as initialized
      setIsInitialized(true);
    } else if (!isOpen) {
      // Reset all form state when form closes; ignore any old reload response.
      editEpoch.current += 1;
      setEditBaseline(null);
      setHasConflict(false);
      setReconciliationError('');
      setLatestPump(null);
      setLatestError('');
      setLoadingLatest(false);
      setLoading(false);
      setIsInitialized(false);
      setInitializedTime(null);
      setFormData({
        startTime: '',
        endTime: '',
        leftAmount: '',
        rightAmount: '',
        totalAmount: '',
        unitAbbr: readCachedDefaultBottleUnit(),
        notes: '',
      });
      setPumpAction('STORED');
      setEditedTimes({ start: false, end: false });
      setAdjustAmount('');
      setAdjustUnit(readCachedDefaultBottleUnit());
      setAdjustIsAdding(true);
      setAdjustReason('Initial Stock');
      setAdjustNotes('');
      setIsAdjustMode(false);
    }
  }, [isOpen, activity, initialTime]);

  // Handle amount increment/decrement
  const incrementAmount = (field: 'leftAmount' | 'rightAmount') => {
    const currentAmount = parseFloat(formData[field] || '0');
    const step = formData.unitAbbr === 'ML' ? 5 : 0.5;
    const newAmount = (currentAmount + step).toFixed(1); // Only show one decimal place
    
    // Update the field and recalculate total
    updateAmountField(field, newAmount);
  };

  const decrementAmount = (field: 'leftAmount' | 'rightAmount') => {
    const currentAmount = parseFloat(formData[field] || '0');
    const step = formData.unitAbbr === 'ML' ? 5 : 0.5;
    if (currentAmount >= step) {
      const newAmount = (currentAmount - step).toFixed(1); // Only show one decimal place
      
      // Update the field and recalculate total
      updateAmountField(field, newAmount);
    }
  };

  // Update amount field and recalculate total
  const updateAmountField = (field: 'leftAmount' | 'rightAmount' | 'totalAmount', value: string) => {
    // For amount fields, allow any numeric values
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      if (field === 'leftAmount' || field === 'rightAmount') {
        // Update the specific field
        setFormData(prev => ({ ...prev, [field]: value }));
        
        // Recalculate total
        const leftVal = field === 'leftAmount' ? value : formData.leftAmount;
        const rightVal = field === 'rightAmount' ? value : formData.rightAmount;
        
        const leftNum = leftVal ? parseFloat(leftVal) : 0;
        const rightNum = rightVal ? parseFloat(rightVal) : 0;
        
        setFormData(prev => ({ 
          ...prev, 
          [field]: value,
          totalAmount: (leftNum + rightNum).toFixed(1) // Only show one decimal place
        }));
      } else {
        // Just update the total field directly
        setFormData(prev => ({ ...prev, totalAmount: value }));
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    
    if (['leftAmount', 'rightAmount', 'totalAmount'].includes(name)) {
      updateAmountField(name as 'leftAmount' | 'rightAmount' | 'totalAmount', value);
    } else {
      setFormData(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleAdjustmentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!babyId) {
      console.error('No baby selected');
      return;
    }

    const parsedAmount = parseFloat(adjustAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      showToast({ variant: 'error', title: 'Error', message: t('Please enter a valid amount'), duration: 5000 });
      return;
    }

    setLoading(true);

    try {
      const finalAmount = adjustIsAdding ? parsedAmount : -parsedAmount;
      const utcTime = toUTCString(new Date());

      const payload = {
        babyId,
        time: utcTime,
        amount: finalAmount,
        unitAbbr: adjustUnit,
        reason: adjustReason,
        notes: adjustNotes || undefined,
      };

      const url = adjustmentActivity
        ? `/api/breast-milk-adjustment?id=${adjustmentActivity.id}`
        : '/api/breast-milk-adjustment';
      const method = adjustmentActivity ? 'PUT' : 'POST';

      const authToken = localStorage.getItem('authToken');
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authToken ? `Bearer ${authToken}` : '',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 403) {
          const { isExpirationError } = await handleExpirationError(response, showToast, 'adjusting breast milk inventory');
          if (isExpirationError) return;
        }
        const data = await response.json();
        showToast({ variant: 'error', title: 'Error', message: data.error || 'Failed to save adjustment', duration: 5000 });
        return;
      }

      const data = await response.json();
      if (data.success) {
        onClose();
        if (onSuccess) onSuccess();
      } else {
        showToast({ variant: 'error', title: 'Error', message: data.error || 'Failed to save adjustment', duration: 5000 });
      }
    } catch (error) {
      console.error('Error saving adjustment:', error);
      showToast({ variant: 'error', title: 'Error', message: 'An unexpected error occurred.', duration: 5000 });
    } finally {
      setLoading(false);
    }
  };

  const loadLatestPump = async () => {
    if (!editBaseline || loadingLatest) return;
    const epoch = editEpoch.current;
    setLoadingLatest(true);
    setLatestError('');
    setLatestPump(null);
    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(`/api/pump-log?id=${encodeURIComponent(editBaseline.id)}`, {
        cache: 'no-store',
        headers: { Authorization: authToken ? `Bearer ${authToken}` : '' },
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json();
      if (epoch !== editEpoch.current) return;
      if (!response.ok || !result.success || !result.data) {
        setLatestError(response.status === 404
          ? 'This pumping record is no longer available for this child. Close this form and reopen it from the correct history.'
          : 'Could not load the latest record. Your unsaved input is unchanged. Check your connection and sign-in, then try again.');
        return;
      }
      const latest: PumpLogResponse = result.data;
      if (latest.id !== editBaseline.id || latest.babyId !== editBaseline.babyId
          || latest.familyId !== editBaseline.familyId || latest.deletedAt || !isPumpRevision(latest.updatedAt)) {
        setLatestError('This pumping record is no longer available for this child. Close this form and reopen it from the correct history.');
        return;
      }
      setLatestPump(latest);
    } catch {
      if (epoch === editEpoch.current) setLatestError('Could not load the latest record. Your unsaved input is unchanged. Check your connection and sign-in, then try again.');
    } finally {
      if (epoch === editEpoch.current) setLoadingLatest(false);
    }
  };

  const replaceDraftWithLatest = () => {
    if (!latestPump || loadingLatest || reconciliationError) return;
    populatePumpFields(latestPump);
    setEditBaseline({ ...latestPump });
    setHasConflict(false);
    setLatestPump(null);
    setLatestError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (loading || hasConflict || (activity && !editBaseline)) return;
    const targetBabyId = editBaseline?.babyId ?? babyId;
    if (!targetBabyId) {
      console.error('No baby selected');
      return;
    }
    const epoch = editEpoch.current;
    
    setLoading(true);
    
    try {
      // Calculate duration between start and end times
      let duration: number | undefined = undefined;
      duration = Math.round((selectedEndDateTime.getTime() - selectedStartDateTime.getTime()) / 60000); // Convert ms to minutes
      
      // Convert local times to UTC ISO strings using the selectedDateTime objects
      const utcStartTime = toUTCString(selectedStartDateTime);
      
      // Convert end time to UTC
      const utcEndTime = toUTCString(selectedEndDateTime);
      if (!utcStartTime || !utcEndTime) throw new Error('Invalid pumping time');
      
      console.log('Original start time (local):', selectedStartDateTime.toLocaleString());
      console.log('Converted start time (UTC):', utcStartTime);
      console.log('Original end time (local):', selectedEndDateTime.toLocaleString());
      console.log('Converted end time (UTC):', utcEndTime);
      
      const payload: PumpLogCreate = {
        babyId: targetBabyId,
        startTime: utcStartTime,
        endTime: utcEndTime,
        duration,
        leftAmount: formData.leftAmount ? parseFloat(formData.leftAmount) : undefined,
        rightAmount: formData.rightAmount ? parseFloat(formData.rightAmount) : undefined,
        totalAmount: formData.totalAmount ? parseFloat(formData.totalAmount) : undefined,
        unitAbbr: formData.unitAbbr || 'OZ',
        pumpAction,
        notes: formData.notes || undefined,
      };
      
      // Determine if we're creating a new record or updating an existing one
      if (editBaseline && !isPumpRevision(editBaseline.updatedAt)) {
        setHasConflict(true);
        return;
      }
      const url = editBaseline ? `/api/pump-log?id=${editBaseline.id}` : '/api/pump-log';
      const method = editBaseline ? 'PUT' : 'POST';
      
      // Get auth token from localStorage
      const authToken = localStorage.getItem('authToken');
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authToken ? `Bearer ${authToken}` : '',
        },
        body: JSON.stringify(editBaseline ? {
          ...changedPumpFields(editBaseline, payload, editedTimes),
          expectedUpdatedAt: editBaseline.updatedAt,
        } : payload),
      });
      if (epoch !== editEpoch.current) return;
      
      if (!response.ok) {
        if (response.status === 409 && editBaseline) {
          const conflict = await response.json().catch(() => null);
          if (epoch !== editEpoch.current) return;
          setHasConflict(true);
          setReconciliationError(conflict?.code === 'PUMP_RECONCILIATION_REQUIRED'
            ? typeof conflict.error === 'string' ? conflict.error : 'This pumping session needs a review of its pumping and feeding history before it can be changed.'
            : '');
          setLatestPump(null);
          setLatestError('');
          return;
        }
        // Check if this is an account expiration error
        if (response.status === 403) {
          const { isExpirationError } = await handleExpirationError(
            response,
            showToast,
            'logging pump sessions'
          );
          if (isExpirationError) {
            // Don't close the form, let user see the error
            return;
          }
        }
        
        // For other errors, parse and display
        const data = await response.json();
        showToast({
          variant: 'error',
          title: 'Error',
          message: data.error || 'Failed to save pump log',
          duration: 5000,
        });
        return;
      }
      
      const data = await response.json();
      if (epoch !== editEpoch.current) return;
      
      if (data.success) {
        // Close the form and trigger the success callback
        onClose();
        if (onSuccess) onSuccess();
      } else {
        showToast({
          variant: 'error',
          title: 'Error',
          message: data.error || 'Failed to save pump log',
          duration: 5000,
        });
      }
    } catch (error) {
      if (epoch !== editEpoch.current) return;
      console.error('Error saving pump log:', error);
      showToast({
        variant: 'error',
        title: 'Error',
        message: 'An unexpected error occurred. Please try again.',
        duration: 5000,
      });
    } finally {
      if (epoch === editEpoch.current) setLoading(false);
    }
  };

  const adjustReasons = ['Initial Stock', 'Expired', 'Spilled', 'Donated', 'Other'];

  const incrementAdjustAmount = () => {
    const current = parseFloat(adjustAmount || '0');
    const step = adjustUnit === 'ML' ? 5 : 0.5;
    setAdjustAmount((current + step).toFixed(1));
  };

  const decrementAdjustAmount = () => {
    const current = parseFloat(adjustAmount || '0');
    const step = adjustUnit === 'ML' ? 5 : 0.5;
    if (current >= step) {
      setAdjustAmount((current - step).toFixed(1));
    }
  };

  // Determine titles based on mode
  const getTitle = () => {
    if (isAdjustMode) {
      return adjustmentActivity ? t('Edit Adjustment') : t('Adjust Inventory');
    }
    return activity ? t('Edit Pump') : t('New Pump');
  };

  const getDescription = () => {
    if (isAdjustMode) {
      return t('Add or remove breast milk from your stored inventory');
    }
    return activity ? t('Update details about your pumping session') : t('Record details about your pumping session');
  };

  return (
    <FormPage
      isOpen={isOpen}
      onClose={onClose}
      title={getTitle()}
      description={getDescription()}
    >
        <FormPageContent>
          {hasConflict && !isAdjustMode && (
            <PumpConflictReview latest={latestPump} loading={loadingLatest} error={latestError}
              reconciliationError={reconciliationError} onLoad={loadLatestPump} onReplace={replaceDraftWithLatest} />
          )}
          {/* Mode Switch - only show when not editing and breast milk tracking is enabled */}
          {breastMilkTrackingEnabled && !activity && !adjustmentActivity && (
            <div className="flex items-center gap-3 px-1 py-3 mb-4">
              <Label className="text-sm font-medium">{t('Pump Session')}</Label>
              <Switch
                checked={isAdjustMode}
                onCheckedChange={setIsAdjustMode}
                disabled={loading}
              />
              <Label className="text-sm font-medium">{t('Adjust Inventory')}</Label>
            </div>
          )}

          {isAdjustMode ? (
            /* Adjustment Mode Form */
            <form onSubmit={handleAdjustmentSubmit}>
              <div className="space-y-4">
                {/* Add/Remove Toggle */}
                <div className="space-y-2">
                  <Label>{t('Type')}</Label>
                  <div className="flex space-x-2">
                    <Button
                      type="button"
                      variant={adjustIsAdding ? 'default' : 'outline'}
                      className="w-full"
                      onClick={() => setAdjustIsAdding(true)}
                      disabled={loading}
                    >
                      + {t('Add')}
                    </Button>
                    <Button
                      type="button"
                      variant={!adjustIsAdding ? 'default' : 'outline'}
                      className="w-full"
                      onClick={() => setAdjustIsAdding(false)}
                      disabled={loading}
                    >
                      - {t('Remove')}
                    </Button>
                  </div>
                </div>

                {/* Unit Selection */}
                <div className="space-y-2">
                  <Label>{t('Unit')}</Label>
                  <div className="flex space-x-2">
                    <Button type="button" variant={adjustUnit === 'OZ' ? 'default' : 'outline'} className="w-full" onClick={() => setAdjustUnit('OZ')} disabled={loading}>{t('oz')}</Button>
                    <Button type="button" variant={adjustUnit === 'ML' ? 'default' : 'outline'} className="w-full" onClick={() => setAdjustUnit('ML')} disabled={loading}>{t('ml')}</Button>
                  </div>
                </div>

                {/* Amount */}
                <div className="space-y-2">
                  <Label htmlFor="adjustAmount">{t('Amount')}</Label>
                  <div className="flex items-center">
                    <Button type="button" variant="outline" size="icon" onClick={decrementAdjustAmount} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg" aria-label={t('Decrease amount')}>
                      <Minus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                    <div className="flex mx-2">
                      <Input id="adjustAmount" type="text" inputMode="decimal" placeholder={t("0.0")} value={adjustAmount} onChange={(e) => { if (e.target.value === '' || /^\d*\.?\d*$/.test(e.target.value)) setAdjustAmount(e.target.value); }} className="rounded-r-none text-center text-lg w-24" />
                      <div className="inline-flex items-center px-3 bg-gray-200 border border-l-0 border-gray-300 rounded-r-md amount-unit">{unitSymbol(adjustUnit)}</div>
                    </div>
                    <Button type="button" variant="outline" size="icon" onClick={incrementAdjustAmount} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg" aria-label={t('Increase amount')}>
                      <Plus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {/* Reason */}
                <div className="space-y-2">
                  <Label>{t('Reason')}</Label>
                  <div className="flex flex-wrap gap-2">
                    {adjustReasons.map((reason) => (
                      <Button key={reason} type="button" variant={adjustReason === reason ? 'default' : 'outline'} className="flex-1 min-w-[80px]" onClick={() => setAdjustReason(reason)} disabled={loading}>
                        {t(reason)}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Notes */}
                <div className="space-y-2">
                  <Label htmlFor="adjustNotes">{t('Notes')}</Label>
                  <Textarea id="adjustNotes" placeholder={t("Enter any notes")} value={adjustNotes} onChange={(e) => setAdjustNotes(e.target.value)} rows={3} disabled={loading} />
                </div>
              </div>
            </form>
          ) : (
            /* Pump Session Form */
            <form onSubmit={handleSubmit}>
              <div className="space-y-4">
                {/* Start Time Input */}
                <div className="space-y-2">
                  <Label htmlFor="startTime">{t('Start Time')}</Label>
                  <DateTimePicker value={selectedStartDateTime} onChange={handleStartDateTimeChange} disabled={loading} placeholder={t("Select start time...")} />
                </div>

                {/* End Time Input */}
                <div className="space-y-2">
                  <Label htmlFor="endTime">{t('End Time')}</Label>
                  <DateTimePicker value={selectedEndDateTime} onChange={handleEndDateTimeChange} disabled={loading} placeholder={t("Select end time...")} />
                </div>

                {/* Unit Selection */}
                <div className="space-y-2">
                  <Label htmlFor="unitAbbr">{t('Unit')}</Label>
                  <div className="flex space-x-2">
                    <Button type="button" variant={formData.unitAbbr === 'OZ' ? 'default' : 'outline'} className="w-full unit-button" onClick={() => setFormData(prev => ({ ...prev, unitAbbr: 'OZ' }))} disabled={loading}>{t('oz')}</Button>
                    <Button type="button" variant={formData.unitAbbr === 'ML' ? 'default' : 'outline'} className="w-full unit-button" onClick={() => setFormData(prev => ({ ...prev, unitAbbr: 'ML' }))} disabled={loading}>{t('ml')}</Button>
                  </div>
                </div>

                {/* Left Amount Input */}
                <div className="space-y-2">
                  <Label htmlFor="leftAmount">{t('Left Amount')}</Label>
                  <div className="flex items-center">
                    <Button type="button" variant="outline" size="icon" onClick={() => decrementAmount('leftAmount')} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg hover:shadow-xl hover:-translate-y-0.5 decrement-button" aria-label={t('Decrease left amount')}>
                      <Minus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                    <div className="flex mx-2">
                      <Input id="leftAmount" name="leftAmount" type="text" inputMode="decimal" placeholder={t("0.0")} value={formData.leftAmount} onChange={handleInputChange} className="rounded-r-none text-center text-lg w-24" />
                      <div className="inline-flex items-center px-3 bg-gray-200 border border-l-0 border-gray-300 rounded-r-md amount-unit">{unitSymbol(formData.unitAbbr)}</div>
                    </div>
                    <Button type="button" variant="outline" size="icon" onClick={() => incrementAmount('leftAmount')} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg hover:shadow-xl hover:-translate-y-0.5 increment-button" aria-label={t('Increase left amount')}>
                      <Plus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {/* Right Amount Input */}
                <div className="space-y-2">
                  <Label htmlFor="rightAmount">{t('Right Amount')}</Label>
                  <div className="flex items-center">
                    <Button type="button" variant="outline" size="icon" onClick={() => decrementAmount('rightAmount')} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg hover:shadow-xl hover:-translate-y-0.5 decrement-button" aria-label={t('Decrease right amount')}>
                      <Minus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                    <div className="flex mx-2">
                      <Input id="rightAmount" name="rightAmount" type="text" inputMode="decimal" placeholder={t("0.0")} value={formData.rightAmount} onChange={handleInputChange} className="rounded-r-none text-center text-lg w-24" />
                      <div className="inline-flex items-center px-3 bg-gray-200 border border-l-0 border-gray-300 rounded-r-md amount-unit">{unitSymbol(formData.unitAbbr)}</div>
                    </div>
                    <Button type="button" variant="outline" size="icon" onClick={() => incrementAmount('rightAmount')} disabled={loading} className="bg-gradient-to-r from-teal-600 to-emerald-600 border-0 rounded-full h-10 w-10 flex items-center justify-center shadow-lg hover:shadow-xl hover:-translate-y-0.5 increment-button" aria-label={t('Increase right amount')}>
                      <Plus className="h-4 w-4 text-white" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {/* Total Amount */}
                <div className="space-y-2">
                  <Label htmlFor="totalAmount">{t('Total Amount')}</Label>
                  <div className="flex">
                    <Input id="totalAmount" name="totalAmount" type="text" inputMode="decimal" placeholder={t("0.0")} value={formData.totalAmount} onChange={handleInputChange} className="rounded-r-none text-lg" />
                    <div className="inline-flex items-center px-3 bg-gray-200 border border-l-0 border-gray-300 rounded-r-md amount-unit">{unitSymbol(formData.unitAbbr)}</div>
                  </div>
                </div>

                {/* Unresolved imported sessions remain reviewable even with stock tracking off. */}
                {(breastMilkTrackingEnabled || activity?.pumpAction === 'UNKNOWN') && (
                <div className="space-y-2">
                  <Label>{t('Action')}</Label>
                  <div className="flex flex-wrap gap-2" role="group" aria-label={t('Action')}>
                    {PUMP_ACTIONS.map(action => (
                      <Button key={action} type="button" variant={pumpAction === action ? 'default' : 'outline'} className="flex-1 min-w-[100px]" onClick={() => setPumpAction(action)} disabled={loading} aria-pressed={pumpAction === action}>
                        {t(pumpActionLabel(action))}
                      </Button>
                    ))}
                  </div>
                  {pumpAction === 'UNKNOWN' && (
                    <p role="status" className="text-sm text-gray-600 pump-review-hint">
                      {t('This pumping session needs review. It adds no milk to your stock and creates no feeding entry. Choose Stored, Fed or Discarded only when you know what happened.')}
                    </p>
                  )}
                </div>
                )}

                {/* Notes */}
                <div className="space-y-2">
                  <Label htmlFor="notes">{t('Notes')}</Label>
                  <Textarea id="notes" name="notes" placeholder={t("Enter any notes about the pumping session")} value={formData.notes} onChange={handleInputChange} rows={3} />
                </div>
              </div>
            </form>
          )}
        </FormPageContent>

        <FormPageFooter>
          <div className="flex justify-end space-x-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={isAdjustMode ? handleAdjustmentSubmit : handleSubmit}
              disabled={loading || (!isAdjustMode && (hasConflict || Boolean(activity && !editBaseline)))}
            >
              {loading ? t('Saving...') : ((activity || adjustmentActivity) ? t('Update') : t('Save'))}
            </Button>
          </div>
        </FormPageFooter>
    </FormPage>
  );
}
