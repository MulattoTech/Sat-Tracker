'use client';

import React, { useId } from 'react';
import { Moon, ChevronDown } from 'lucide-react';
import { BabySelectorProps } from './baby-selector.types';
import {
  babySelectorContainer,
  babySelectorContent,
  babySelectorNameContainer,
  babySelectorName,
  babySelectorAge,
  babySelectorDropdownButton,
  babySelectorDropdownItem
} from './baby-selector.styles';
import { Button } from '@/src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/src/components/ui/dropdown-menu";
import { useLocalization } from '@/src/context/localization';
import ChildAgeDisplay from '@/src/components/ChildAgeDisplay';

/**
 * BabySelector Component
 * 
 * A component that displays the currently selected baby and allows
 * switching between babies via a dropdown menu. It also provides
 * access to the baby's quick stats.
 * 
 * @example
 * ```tsx
 * <BabySelector
 *   selectedBaby={selectedBaby}
 *   onBabySelect={setSelectedBaby}
 *   babies={babies}
 *   sleepingBabies={sleepingBabies}
 *   timeZone={userTimezone}
 *   onOpenQuickStats={handleOpenQuickStats}
 * />
 * ```
 */
export const BabySelector: React.FC<BabySelectorProps> = ({
  selectedBaby,
  onBabySelect,
  babies,
  sleepingBabies,
  timeZone,
  onOpenQuickStats
}) => {
  const { t } = useLocalization();
  const ageId = useId();

  return (
    <div className={babySelectorContainer(selectedBaby?.gender)}>
      {/* Baby info section (clickable for quick stats) */}
      <button
        type="button"
        className={babySelectorContent()}
        onClick={onOpenQuickStats}
        aria-label={selectedBaby ? `${selectedBaby.firstName}${t("'s Quick Stats")}` : undefined}
        aria-describedby={selectedBaby ? ageId : undefined}
      >
        <div className={babySelectorNameContainer()}>
          <span className={babySelectorName()}>
            {selectedBaby ? selectedBaby.firstName : t('Select Baby')}
          </span>
          {selectedBaby && sleepingBabies.has(selectedBaby.id) && (
            <Moon className="h-3 w-3" aria-hidden="true" />
          )}
        </div>
        {selectedBaby && (
          <ChildAgeDisplay
            id={ageId}
            birthDate={selectedBaby.birthDate}
            gestationalAgeDays={selectedBaby.gestationalAgeDays}
            timeZone={timeZone}
            className={babySelectorAge()}
          />
        )}
      </button>
      
      {/* Dropdown button (separate from the main content) */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={babySelectorDropdownButton()}
            aria-label={t('Select Baby')}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
          <DropdownMenuRadioGroup
            value={selectedBaby?.id || ''}
            onValueChange={(id) => {
              if (id) {
                const baby = babies.find((b) => b.id === id);
                if (baby) {
                  onBabySelect(baby);
                }
              }
            }}
          >
            {babies.map((baby) => (
              <DropdownMenuRadioItem
                key={baby.id}
                value={baby.id}
                className={babySelectorDropdownItem(baby.gender)}
              >
                <div className="flex min-w-0 flex-col">
                  <span>{baby.firstName}{baby.inactive ? ` ${t('(Inactive)')}` : ''}</span>
                  <ChildAgeDisplay
                    birthDate={baby.birthDate}
                    gestationalAgeDays={baby.gestationalAgeDays}
                    timeZone={timeZone}
                  />
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default BabySelector;
