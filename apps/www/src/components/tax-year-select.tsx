import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./ui/select"
import { taxYears } from "#/components/dashboard/data"
import type { TaxYear } from "#/components/dashboard/types"

export function TaxYearSelect({ taxYear }: { taxYear: TaxYear }) {
  return (
    <Select>
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder={taxYear.toString()} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {taxYears.map((item) => (
            <SelectItem key={item} value={item.toString()}>
              {item}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
