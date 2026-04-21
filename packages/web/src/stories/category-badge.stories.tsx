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

const approved = CategorySchema.parse("approved");
const checksFailed = CategorySchema.parse("checks_failed");
const snoozed = CategorySchema.parse("snoozed");

export const HappyPath: Story = { args: { category: approved } };
export const ErrorPath: Story = { args: { category: checksFailed } };
export const EdgeCase: Story = { args: { category: snoozed } };
