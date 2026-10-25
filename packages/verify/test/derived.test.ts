import { describe, expect, it } from "vitest";
import type { Fact } from "@maycombhq/core";
import { memorySource, verifyFacts } from "../src/index.js";
import {
  laravelSnake,
  pluralize,
  railsUnderscore,
  springSnake,
  typeormSnake,
} from "../src/derived.js";

/**
 * Names a framework derives, which no line writes (ADR 0124 addendum A-derived): each is
 * accepted only when the cited line, or a `cite.with` part, declares its source, and the claim is
 * the framework's name exactly. Invented Forge code throughout.
 */

const base = {
  repo: "forge",
  commit: "0123abc",
  verified: "none" as const,
  by: "assistant" as const,
  conf: "declared" as const,
};
type Part = { file: string; line: number; value: string };
const store = (id: string, name: string, file: string, line: number, value: string, w?: Part[]) =>
  ({
    ...base,
    kind: "store",
    id,
    store: "forge-db",
    name,
    op: "read",
    cite: { file, line, value, ...(w ? { with: w } : {}) },
  }) as Fact;
const column = (
  id: string,
  name: string,
  owner: string,
  file: string,
  line: number,
  value: string,
) =>
  ({
    ...base,
    kind: "field",
    id,
    owner,
    side: "column",
    name,
    cite: { file, line, value },
  }) as Fact;
const entry = (
  id: string,
  path: string,
  file: string,
  line: number,
  value: string,
  w?: Part[],
  entryType = "rest",
) =>
  ({
    ...base,
    kind: "entry",
    id,
    entryType,
    ...(entryType === "rest" ? { method: "GET" } : {}),
    path,
    cite: { file, line, value, ...(w ? { with: w } : {}) },
  }) as Fact;

const outcome = async (src: ReturnType<typeof memorySource>, facts: Fact[]) => {
  const r = await verifyFacts({ source: src, facts });
  return {
    accepted: r.accepted.map((f) => f.id).sort(),
    rejected: r.rejected.map((x) => `${x.fact.id}:${x.code}`).sort(),
  };
};

describe("the naming helpers, each the framework's own rule", () => {
  it("pluralizes as ActiveSupport's default inflections do", () => {
    const cases: [string, string][] = [
      ["doc_class", "doc_classes"],
      ["repo_badge", "repo_badges"],
      ["category", "categories"],
      ["status", "statuses"],
      ["box", "boxes"],
      ["shelf", "shelves"],
      ["knife", "knives"],
      ["datum", "data"],
      ["analysis", "analyses"],
      ["axis", "axes"],
      ["equipment", "equipment"],
      ["mouse", "mice"],
      ["quiz", "quizzes"],
      ["matrix", "matrices"],
      ["bus", "buses"],
      ["alias", "aliases"],
      ["tomato", "tomatoes"],
      ["hive", "hives"],
      ["ox", "oxen"],
      ["person", "people"],
      ["child", "children"],
      ["sales_person", "sales_people"],
      ["ledgerEntry", "ledgerEntries"],
      ["key", "keys"],
    ];
    for (const [one, many] of cases) expect([one, pluralize(one)]).toEqual([one, many]);
  });
  it("snake-cases as Spring's, Rails', Laravel's and TypeORM's strategies do", () => {
    expect(springSnake("OrderLine")).toBe("order_line");
    expect(springSnake("LEDGERTABLE_ledgerLine")).toBe("ledgertable_ledger_line");
    expect(springSnake("customer_customerId")).toBe("customer_customer_id");
    expect(springSnake("URLRecord")).toBe("urlrecord");
    expect(railsUnderscore("DocClass")).toBe("doc_class");
    expect(railsUnderscore("HTMLPage")).toBe("html_page");
    expect(laravelSnake("ArticleTag")).toBe("article_tag");
    expect(typeormSnake("ForgeArticle")).toBe("forge_article");
    expect(typeormSnake("HTMLPage")).toBe("html_page");
  });
});

describe("ORM tables a naming strategy derives (A-derived)", () => {
  it("Spring's snake_case of a JPA entity, its join tables and its foreign key columns", async () => {
    const dir = "ledger/src/main/java/com/forge/ledger";
    const src = memorySource({
      [`${dir}/LedgerLine.java`]: [
        "package com.forge.ledger;",
        "",
        "@Entity",
        "public class LedgerLine {",
        "  @Id",
        "  @GeneratedValue",
        "  private long id;",
        "}",
      ].join("\n"),
      [`${dir}/Ledger.java`]: [
        "package com.forge.ledger;",
        "",
        "@Entity",
        '@Table(name = "LEDGERTABLE")',
        "public class Ledger {",
        "  @Id",
        "  @GeneratedValue",
        "  private long id;",
        "",
        "  @ManyToOne",
        "  private Customer customer;",
        "",
        "  @OneToMany(cascade = CascadeType.ALL)",
        "  private List<LedgerLine> ledgerLine;",
        "",
        '  @OneToMany(mappedBy = "ledger")',
        "  private List<LedgerNote> notes;",
        "",
        "  @ElementCollection",
        "  private Set<String> tags;",
        "}",
      ].join("\n"),
      [`${dir}/Customer.java`]: [
        "package com.forge.ledger;",
        "",
        "@Entity",
        "public class Customer {",
        "  @Id",
        "  @GeneratedValue",
        "  private Long customerId;",
        "}",
      ].join("\n"),
      [`${dir}/LedgerService.java`]: [
        "public class LedgerService {",
        "  public void post(Ledger ledger) {",
        "    ledgerRepository.save(ledger);",
        "  }",
        "}",
      ].join("\n"),
    });
    const L = `${dir}/Ledger.java`;
    const r = await outcome(src, [
      // cited where the code saves it, the entity's class line in `with`
      store("s-line", "ledger_line", `${dir}/LedgerService.java`, 3, "ledgerRepository.save", [
        { file: `${dir}/LedgerLine.java`, line: 4, value: "LedgerLine" },
      ]),
      store("s-line-on-entity", "ledger_line", `${dir}/LedgerLine.java`, 3, "@Entity"),
      store("s-join-spring", "ledgertable_ledger_line", L, 14, "ledgerLine"),
      store("s-coll", "ledger_tags", L, 20, "tags"),
      column("f-fk", "customer_customer_id", "s-line-on-entity", L, 11, "customer"),
      column("f-join-owner", "ledger_id", "s-join-spring", L, 14, "ledgerLine"),
      column("f-join-target", "ledger_line_id", "s-join-spring", L, 14, "ledgerLine"),
      // not what the strategy gives
      store("x-plural", "ledger_lines", `${dir}/LedgerLine.java`, 4, "LedgerLine"),
      // @Table names it, so there is nothing to derive
      store("x-table-named", "forge_ledger", L, 5, "Ledger"),
      // mappedBy: the other side owns it, so there is no join table
      store("x-mapped", "ledgertable_notes", L, 17, "notes"),
      // the source isn't on the cited line
      store("x-far", "ledger_line", `${dir}/LedgerService.java`, 3, "ledgerRepository.save"),
    ]);
    expect(r.rejected).toEqual([
      "x-far:claim-not-on-line",
      "x-mapped:claim-not-on-line",
      "x-plural:claim-not-on-line",
      "x-table-named:claim-not-on-line",
    ]);
    expect(r.accepted).toEqual(
      [
        "f-fk",
        "f-join-owner",
        "f-join-target",
        "s-coll",
        "s-join-spring",
        "s-line",
        "s-line-on-entity",
      ].sort(),
    );
  });

  it("Django's <app_label>_<model>, from the app folder or AppConfig's label, and its many-to-many tables", async () => {
    const src = memorySource({
      "forge/__init__.py": "",
      "forge/common/models.py": [
        "from django.db import models",
        "",
        "class BaseModel(models.Model):",
        "    created_at = models.DateTimeField(auto_now_add=True)",
        "",
        "    class Meta:",
        "        abstract = True",
      ].join("\n"),
      "forge/accounts/models.py": [
        "from forge.common.models import BaseModel",
        "",
        "class ForgeUser(AbstractBaseUser, BaseModel):",
        "    email = models.EmailField(unique=True)",
        "",
        "class Status(models.TextChoices):",
        '    ACTIVE = "active"',
        "",
        "class Course(BaseModel):",
        "    students = models.ManyToManyField(ForgeUser)",
        '    mentors = models.ManyToManyField(ForgeUser, through="Mentoring")',
        "    owner = models.ForeignKey(ForgeUser, on_delete=models.CASCADE)",
      ].join("\n"),
      "forge/accounts/selectors.py": "def user_list():\n    return ForgeUser.objects.all()\n",
      "forge/ledger/apps.py": [
        "class LedgerConfig(AppConfig):",
        '    name = "forge.ledger"',
        '    label = "books"',
      ].join("\n"),
      "forge/ledger/models/entry.py":
        "class Entry(BaseModel):\n    amount = models.DecimalField()\n",
      // a models module in a folder of the app, not an app of its own
      "forge/ledger/audit/models.py":
        "class AuditEntry(models.Model):\n    at = models.DateTimeField()\n",
    });
    const A = "forge/accounts/models.py";
    const r = await outcome(src, [
      store("s-user", "accounts_forgeuser", "forge/accounts/selectors.py", 2, "ForgeUser.objects", [
        { file: A, line: 3, value: "ForgeUser" },
      ]),
      store("s-label", "books_entry", "forge/ledger/models/entry.py", 1, "Entry"),
      store("s-in-app", "books_auditentry", "forge/ledger/audit/models.py", 1, "AuditEntry"),
      store("x-not-an-app", "audit_auditentry", "forge/ledger/audit/models.py", 1, "AuditEntry"),
      store("s-m2m", "accounts_course_students", A, 10, "students"),
      column("f-fk", "owner_id", "s-m2m", A, 12, "owner"),
      store("x-folder-not-label", "ledger_entry", "forge/ledger/models/entry.py", 1, "Entry"),
      store("x-abstract", "common_basemodel", "forge/common/models.py", 3, "BaseModel"),
      store("x-choices", "accounts_status", A, 6, "Status"),
      store("x-through", "accounts_course_mentors", A, 11, "mentors"),
      store("x-dotted", "accounts.forgeuserx", A, 3, "ForgeUser"),
    ]);
    expect(r.rejected).toEqual([
      "x-abstract:claim-not-on-line",
      "x-choices:claim-not-on-line",
      "x-dotted:claim-not-on-line",
      "x-folder-not-label:claim-not-on-line",
      "x-not-an-app:claim-not-on-line",
      "x-through:claim-not-on-line",
    ]);
    expect(r.accepted).toEqual(["f-fk", "s-in-app", "s-label", "s-m2m", "s-user"]);
  });

  it("Rails' and Laravel's plural tables from a model class, and Laravel's pivot table", async () => {
    const src = memorySource({
      "app/models/repo_badge.rb": "class RepoBadge < ApplicationRecord\n  belongs_to :repo\nend\n",
      "app/models/person.rb": "class Person < ActiveRecord::Base\nend\n",
      "app/models/legacy_widget.rb":
        'class LegacyWidget < ApplicationRecord\n  self.table_name = "widgets_v1"\nend\n',
      "app/models/application_record.rb":
        "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
      "app/Models/InvoiceTag.php": "<?php\n\nclass InvoiceTag extends Model\n{\n}\n",
      "app/Models/Invoice.php": [
        "<?php",
        "",
        "final class Invoice extends Model",
        "{",
        "    public function tags()",
        "    {",
        "        return $this->belongsToMany(Tag::class);",
        "    }",
        "}",
      ].join("\n"),
      "app/Models/Legacy.php":
        "<?php\n\nclass Legacy extends Model\n{\n    protected $table = 'legacy_rows';\n}\n",
    });
    const r = await outcome(src, [
      store("s-rails", "repo_badges", "app/models/repo_badge.rb", 1, "RepoBadge"),
      store("s-rails-irregular", "people", "app/models/person.rb", 1, "Person"),
      store("s-laravel", "invoice_tags", "app/Models/InvoiceTag.php", 3, "InvoiceTag"),
      store("s-pivot", "invoice_tag", "app/Models/Invoice.php", 7, "belongsToMany"),
      store("x-rails-singular", "repo_badge", "app/models/repo_badge.rb", 1, "RepoBadge"),
      store("x-rails-named", "legacy_widgets", "app/models/legacy_widget.rb", 1, "LegacyWidget"),
      store("x-abstract", "application_records", "app/models/application_record.rb", 1, "x"),
      store("x-laravel-named", "legacies", "app/Models/Legacy.php", 3, "Legacy"),
    ]);
    expect(r.rejected).toEqual([
      "x-abstract:claim-not-on-line",
      "x-laravel-named:claim-not-on-line",
      "x-rails-named:claim-not-on-line",
      "x-rails-singular:claim-not-on-line",
    ]);
    expect(r.accepted).toEqual(["s-laravel", "s-pivot", "s-rails", "s-rails-irregular"]);
  });

  it("TypeORM's entity and join tables, and Prisma's implicit many-to-many tables", async () => {
    const src = memorySource({
      "src/article/article.entity.ts": [
        "@Entity()",
        "export class ForgeArticle {",
        "  @ManyToMany(() => Tag)",
        "  @JoinTable()",
        "  tags: Tag[];",
        "}",
      ].join("\n"),
      "src/tag/tag.entity.ts":
        "@Entity()\nexport class Tag {\n  @PrimaryGeneratedColumn() id: number;\n}\n",
      "prisma/schema.prisma": [
        "model Post {",
        "  id         Int        @id",
        "  categories Category[]",
        '  labels     Label[]    @relation("PostLabels")',
        "}",
        "",
        "model Category {",
        "  id    Int    @id",
        "  posts Post[]",
        "}",
        "",
        "model Label {",
        "  id    Int    @id",
        '  posts Post[] @relation("PostLabels")',
        "}",
      ].join("\n"),
    });
    const A = "src/article/article.entity.ts";
    const r = await outcome(src, [
      store("s-entity", "forge_article", A, 2, "ForgeArticle"),
      store("s-join", "forge_article_tags_tag", A, 4, "@JoinTable"),
      store("s-prisma", "_CategoryToPost", "prisma/schema.prisma", 3, "categories"),
      store("s-prisma-named", "_PostLabels", "prisma/schema.prisma", 4, "labels"),
      store("x-join", "forge_article_tag", A, 4, "@JoinTable"),
      store("x-prisma-order", "_PostToCategory", "prisma/schema.prisma", 3, "categories"),
    ]);
    expect(r.rejected).toEqual(["x-join:claim-not-on-line", "x-prisma-order:claim-not-on-line"]);
    expect(r.accepted).toEqual(["s-entity", "s-join", "s-prisma", "s-prisma-named"]);
  });
});

describe("routes a framework derives (A-derived)", () => {
  it("Rails' root, in and out of a namespace", async () => {
    const src = memorySource({
      "config/routes.rb": [
        "Rails.application.routes.draw do",
        '  root to: "pages#index"',
        "  namespace :admin do",
        '    root "dashboard#show"',
        "  end",
        "end",
      ].join("\n"),
    });
    const r = await outcome(src, [
      entry("e-root", "/", "config/routes.rb", 2, "root"),
      entry("e-admin", "/admin", "config/routes.rb", 4, "root"),
      entry("x-admin-bare", "/", "config/routes.rb", 4, "root"),
      entry("x-root-other", "/home", "config/routes.rb", 2, "root"),
    ]);
    expect(r.rejected).toEqual([
      "x-admin-bare:claim-not-on-line",
      "x-root-other:claim-not-on-line",
    ]);
    expect(r.accepted).toEqual(["e-admin", "e-root"]);
  });

  it("Devise's routes, from the modules the model lists", async () => {
    const src = memorySource({
      "config/routes.rb": [
        "Rails.application.routes.draw do",
        '  devise_for :users, controllers: { omniauth_callbacks: "users/omniauth_callbacks" }',
        '  devise_for :admins, skip: [:sessions], path: "staff"',
        "  devise_for :members, skip: [:registration],",
        '    path: "crew"',
        "end",
      ].join("\n"),
      "app/models/member.rb":
        "class Member < ApplicationRecord\n  devise :database_authenticatable, :registerable\nend\n",
      "app/models/user.rb": [
        "class User < ApplicationRecord",
        "  devise :database_authenticatable, :registerable, :recoverable,",
        "         :omniauthable, omniauth_providers: [:github]",
        "end",
      ].join("\n"),
      "app/models/admin.rb":
        "class Admin < ApplicationRecord\n  devise :database_authenticatable, :recoverable\nend\n",
    });
    const R = "config/routes.rb";
    const r = await outcome(src, [
      entry("e-sign-in", "/users/sign_in", R, 2, "devise_for"),
      entry("e-sign-out", "/users/sign_out", R, 2, "devise_for"),
      entry("e-sign-up", "/users/sign_up", R, 2, "devise_for"),
      entry("e-password", "/users/password/new", R, 2, "devise_for"),
      entry("e-callback", "/users/auth/github/callback", R, 2, "devise_for"),
      entry("e-staff-password", "/staff/password", R, 3, "devise_for"),
      // options carried over lines; `skip:` singular or plural, as Devise singularizes it
      entry("e-crew-sign-in", "/crew/sign_in", R, 4, "devise_for"),
      entry("x-crew-sign-up", "/crew/sign_up", R, 4, "devise_for"),
      entry("x-confirm", "/users/confirmation", R, 2, "devise_for"),
      entry("x-skipped", "/staff/sign_in", R, 3, "devise_for"),
      entry("x-path", "/admins/password", R, 3, "devise_for"),
      entry("x-provider", "/users/auth/gitlab/callback", R, 2, "devise_for"),
    ]);
    expect(r.rejected).toEqual([
      "x-confirm:claim-not-on-line",
      "x-crew-sign-up:claim-not-on-line",
      "x-path:claim-not-on-line",
      "x-provider:claim-not-on-line",
      "x-skipped:claim-not-on-line",
    ]);
    expect(r.accepted).toEqual(
      [
        "e-callback",
        "e-crew-sign-in",
        "e-password",
        "e-sign-in",
        "e-sign-out",
        "e-sign-up",
        "e-staff-password",
      ].sort(),
    );
  });

  it("Spring Data REST's paths from @RepositoryRestResource, with a base path in `with`", async () => {
    const dir = "ledger/src/main/java/com/forge/ledger";
    const src = memorySource({
      [`${dir}/LedgerRepository.java`]: [
        '@RepositoryRestResource(collectionResourceRel = "ledger", path = "ledger")',
        "public interface LedgerRepository extends PagingAndSortingRepository<Ledger, Long> {",
        '  List<Ledger> findByOwner(@Param("owner") String owner);',
        "}",
      ].join("\n"),
      [`${dir}/LedgerEntryRepository.java`]: [
        "@RepositoryRestResource",
        "public interface LedgerEntryRepository extends CrudRepository<LedgerEntry, Long> {",
        "}",
      ].join("\n"),
      "ledger/src/main/resources/application.properties": "spring.data.rest.base-path=/api\n",
    });
    const P = `${dir}/LedgerRepository.java`;
    const E = `${dir}/LedgerEntryRepository.java`;
    const r = await outcome(src, [
      entry("e-list", "/ledger", P, 1, "path"),
      entry("e-one", "/ledger/{id}", P, 1, "path"),
      entry("e-search", "/ledger/search/findByOwner", P, 1, "path"),
      entry("e-default", "/ledgerEntries", E, 1, "@RepositoryRestResource"),
      entry("e-base", "/api/ledger/{id}", P, 1, "path", [
        { file: "ledger/src/main/resources/application.properties", line: 1, value: "/api" },
      ]),
      entry("x-plural", "/ledgers", P, 1, "path"),
      entry("x-no-base", "/api/ledger/{id}", P, 1, "path"),
    ]);
    expect(r.rejected).toEqual(["x-no-base:claim-not-on-line", "x-plural:claim-not-on-line"]);
    expect(r.accepted).toEqual(["e-base", "e-default", "e-list", "e-one", "e-search"]);
  });

  it("a background worker's name: ActiveJob's class with its modules, Celery's module and function", async () => {
    const src = memorySource({
      "app/jobs/billing/send_receipt_job.rb": [
        "module Billing",
        "  class SendReceiptJob < ApplicationJob",
        "    def perform(invoice)",
        "    end",
        "  end",
        "end",
      ].join("\n"),
      "app/workers/sync_worker.rb": "class SyncWorker\n  include Sidekiq::Job\nend\n",
      "forge/__init__.py": "",
      "forge/billing/__init__.py": "",
      "forge/billing/tasks.py": [
        "from celery import shared_task",
        "",
        "@shared_task(bind=True)",
        "def send_receipt(self, invoice_id):",
        "    pass",
      ].join("\n"),
    });
    const job = (id: string, path: string, file: string, line: number) =>
      entry(id, path, file, line, path.split(/::|\./).pop()!, undefined, "batch-job");
    const r = await outcome(src, [
      job("e-activejob", "Billing::SendReceiptJob", "app/jobs/billing/send_receipt_job.rb", 2),
      job("e-sidekiq", "SyncWorker", "app/workers/sync_worker.rb", 1),
      job("e-celery", "forge.billing.tasks.send_receipt", "forge/billing/tasks.py", 4),
      job("x-celery", "forge.billing.send_receipt", "forge/billing/tasks.py", 4),
      job("x-module", "Payments::SendReceiptJob", "app/jobs/billing/send_receipt_job.rb", 2),
    ]);
    expect(r.rejected).toEqual(["x-celery:claim-not-on-line", "x-module:claim-not-on-line"]);
    expect(r.accepted).toEqual(["e-activejob", "e-celery", "e-sidekiq"]);
  });
});

describe("a word claim put together from `cite.with` parts (A-derived)", () => {
  const src = memorySource({
    "lib/tasks/schedule.rake": [
      "namespace :schedule do",
      '  desc "Sends the triage emails"',
      "  task triage_emails: :environment do",
      "  end",
      "end",
    ].join("\n"),
    "backend/src/Cache.kt": [
      'val prefix = "forge"',
      'private fun key(name: String) = "${prefix}_$name"',
      "",
      "fun conference() {",
      '  redis.get(key("conferenceCache"))',
      "}",
    ].join("\n"),
  });
  const task = (id: string, path: string, w?: Part[]) =>
    entry(id, path, "lib/tasks/schedule.rake", 3, "triage_emails", w, "batch-job");
  const ns = { file: "lib/tasks/schedule.rake", line: 1, value: "schedule" };
  it("takes a rake task's namespace:task and a key a helper builds", async () => {
    const r = await outcome(src, [
      task("e-task", "schedule:triage_emails", [ns]),
      store("s-key", "forge_conferenceCache", "backend/src/Cache.kt", 5, "conferenceCache", [
        { file: "backend/src/Cache.kt", line: 1, value: "forge" },
      ]),
      store(
        "s-key-template",
        "${prefix}_conferenceCache",
        "backend/src/Cache.kt",
        5,
        "conferenceCache",
        [{ file: "backend/src/Cache.kt", line: 2, value: "${prefix}_" }],
      ),
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual(["e-task", "s-key", "s-key-template"]);
  });
  it("rejects a built word with a part missing, a part not on its line, or a piece written nowhere", async () => {
    const r = await outcome(src, [
      task("x-no-part", "schedule:triage_emails"),
      task("x-wrong-part", "nightly:triage_emails", [{ ...ns, value: "nightly" }]),
      task("x-piece-nowhere", "schedule:triage_all", [ns]),
      task("x-inside-word", "schedulex:triage_emails", [ns]),
    ]);
    expect(r.rejected).toEqual([
      "x-inside-word:claim-not-on-line",
      "x-no-part:claim-not-on-line",
      "x-piece-nowhere:claim-not-on-line",
      "x-wrong-part:claim-not-on-line",
    ]);
  });
});
