/**
 * 身份相关类型与枚举。
 *
 * userRoles / userStatuses 等以 @zmzai/db 为单一来源（与 zmzai-auth / relay 共享），
 * 本模块仅做 re-export 以保持 `@/modules/identity` 对外 API 稳定。
 * UserAccount 是 muzhi 专有的客户端 DTO，留在此处。
 */
export {
  userRoles,
  userStatuses,
  type UserRole,
  type UserStatus,
} from "@zmzai/db";

import type { UserRole, UserStatus } from "@zmzai/db";

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
}
