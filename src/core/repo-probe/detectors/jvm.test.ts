import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectJvm } from './jvm.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-probe-jvm-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  dirs.push(root);
  return root;
}

const POM = (props = '<java.version>17</java.version>') => [
  '<project>',
  '  <properties>',
  `    ${props}`,
  '  </properties>',
  '  <dependencies>',
  '    <dependency><artifactId>junit-jupiter</artifactId></dependency>',
  '  </dependencies>',
  '</project>',
].join('\n');

test('no jvm manifests → not detected', () => {
  assert.equal(detectJvm(repo({ 'README.md': 'x' })).detected, false);
});

test('pom.xml → maven manager, java toolchain from java.version, mvn commands', () => {
  const root = repo({ 'pom.xml': POM() });
  const res = detectJvm(root);

  assert.equal(res.detected, true);
  assert.ok(res.ecosystems.includes('java'));
  assert.ok(res.manifests.includes('pom.xml'));

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'maven');
  assert.equal(pm.sourceFile, 'pom.xml');

  const tc = res.toolchains[0];
  assert.equal(tc.name, 'java');
  assert.equal(tc.version, '17');
  assert.equal(tc.sourceFile, 'pom.xml#java.version');

  assert.equal(res.commands.install, 'mvn dependency:resolve');
  assert.equal(res.commands.test, 'mvn test');
  assert.equal(res.commands.build, 'mvn package -DskipTests');
  assert.equal(res.commands.verify, 'mvn verify');

  assert.ok(res.frameworks.some((f) => f.name === 'junit5'));
});

test('mvnw wrapper switches commands to ./mvnw', () => {
  const root = repo({ 'pom.xml': POM(), 'mvnw': '#!/bin/sh\n' });
  const res = detectJvm(root);
  assert.equal(res.commands.test, './mvnw test');
  assert.ok(res.manifests.includes('mvnw'));
});

test('java version falls back through maven.compiler.source then .target', () => {
  const src = repo({ 'pom.xml': POM('<maven.compiler.source>11</maven.compiler.source>') });
  assert.equal(detectJvm(src).toolchains[0].version, '11');
  assert.equal(detectJvm(src).toolchains[0].sourceFile, 'pom.xml#maven.compiler.source');

  const tgt = repo({ 'pom.xml': POM('<maven.compiler.target>1.8</maven.compiler.target>') });
  assert.equal(detectJvm(tgt).toolchains[0].version, '1.8');
  assert.equal(detectJvm(tgt).toolchains[0].sourceFile, 'pom.xml#maven.compiler.target');
});

test('junit4/testng/spring-boot frameworks detected from pom content', () => {
  const root = repo({
    'pom.xml': '<project><dependencies><dependency><artifactId>junit</artifactId></dependency>'
      + '<dependency><artifactId>testng</artifactId></dependency>'
      + '<dependency><artifactId>spring-boot-starter</artifactId></dependency>'
      + '</dependencies></project>',
  });
  const res = detectJvm(root);
  const names = res.frameworks.map((f) => f.name);
  assert.ok(names.includes('junit4'), `frameworks: ${names}`);
  assert.ok(names.includes('testng'));
  assert.ok(names.includes('spring-boot'));
});

test('build.gradle → gradle manager + gradle commands', () => {
  const root = repo({
    'build.gradle': "plugins { id 'java' }\nsourceCompatibility = '17'\ndependencies { testImplementation 'junit:junit:4.13' }\n",
  });
  const res = detectJvm(root);

  assert.ok(res.ecosystems.includes('java'));
  assert.ok(res.manifests.includes('build.gradle'));

  const pm = res.packageManagers[0];
  assert.equal(pm.name, 'gradle');
  assert.equal(pm.sourceFile, 'build.gradle');

  const tc = res.toolchains[0];
  assert.equal(tc.version, '17');
  assert.equal(tc.sourceFile, 'build.gradle#sourceCompatibility');

  assert.equal(res.commands.install, 'gradle dependencies');
  assert.equal(res.commands.test, 'gradle test');
  assert.equal(res.commands.build, 'gradle build');
  assert.equal(res.commands.lint, 'gradle check');
  assert.ok(res.frameworks.some((f) => f.name === 'junit'));
});

test('build.gradle.kts adds kotlin ecosystem; gradlew wrapper used when present', () => {
  const root = repo({
    'build.gradle.kts': 'plugins { kotlin("jvm") version "1.9" }\ntasks.test { useJUnitPlatform() }\n',
    'gradlew': '#!/bin/sh\n',
  });
  const res = detectJvm(root);

  assert.ok(res.ecosystems.includes('java'));
  assert.ok(res.ecosystems.includes('kotlin'));
  assert.ok(res.manifests.includes('build.gradle.kts'));
  assert.ok(res.manifests.includes('gradlew'));

  assert.equal(res.commands.test, './gradlew test');
  assert.equal(res.commands.install, './gradlew dependencies');
});

test('jvmTarget also supplies the java version', () => {
  const root = repo({ 'build.gradle': 'kotlin { jvmTarget = "21" }\n' });
  const res = detectJvm(root);
  assert.equal(res.toolchains[0].version, '21');
  assert.equal(res.toolchains[0].sourceFile, 'build.gradle#jvmTarget');
  assert.ok(res.ecosystems.includes('java'));
});

test('.java-version wins over manifest-derived versions', () => {
  const root = repo({
    'pom.xml': POM(),
    '.java-version': '21.0.1\n',
  });
  const res = detectJvm(root);
  assert.equal(res.toolchains[0].version, '21.0.1');
  assert.equal(res.toolchains[0].sourceFile, '.java-version');
  assert.ok(res.manifests.includes('.java-version'));
});

test('.java-version alone still detects java (no package manager)', () => {
  const root = repo({ '.java-version': '17\n' });
  const res = detectJvm(root);
  assert.equal(res.detected, true);
  assert.deepEqual(res.packageManagers, []);
  assert.deepEqual(res.commands, {});
});

test('pom.xml + build.gradle: maven commands win (first-detected precedence)', () => {
  const root = repo({
    'pom.xml': POM(),
    'build.gradle': "plugins { id 'java' }\n",
  });
  const res = detectJvm(root);
  // Both managers are recorded…
  assert.deepEqual(res.packageManagers.map((p) => p.name), ['maven', 'gradle']);
  // …but commands come from maven — the gradle block only fills when
  // commands.test is still unset (maven runs first in the implementation).
  assert.equal(res.commands.test, 'mvn test');
  assert.equal(res.commands.install, 'mvn dependency:resolve');
});

test('malformed pom.xml yields no java version but still detects', () => {
  const root = repo({ 'pom.xml': 'not xml at all <<<' });
  const res = detectJvm(root);
  assert.equal(res.detected, true);
  assert.equal(res.toolchains[0].version, undefined);
  assert.equal(res.commands.install, 'mvn dependency:resolve');
});
