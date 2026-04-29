import type { Meta, StoryObj } from "@storybook/react-vite";
import { CategorySchema } from "@wip/shared";
import { CategoryBadge } from "../components/category-badge.js";

const meta: Meta<typeof CategoryBadge> = {
  title: "Components/CategoryBadge",
  component: CategoryBadge,
  argTypes: {
    category: {
      control: "select",
      options: CategorySchema.options,
    },
  },
};

export default meta;
type Story = StoryObj<typeof CategoryBadge>;

export const Approved: Story = { args: { category: "approved" } };
export const ChecksFailed: Story = { args: { category: "checks_failed" } };
export const ChecksRunning: Story = { args: { category: "checks_running" } };
export const NeedsRebase: Story = { args: { category: "needs_rebase" } };
export const ReadyToPush: Story = { args: { category: "ready_to_push" } };
export const TestFailed: Story = { args: { category: "test_failed" } };
export const Untriaged: Story = { args: { category: "untriaged" } };
export const Snoozed: Story = { args: { category: "snoozed" } };

export const AllCategories: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {CategorySchema.options.map((category) => (
        <CategoryBadge key={category} category={category} />
      ))}
    </div>
  ),
};
