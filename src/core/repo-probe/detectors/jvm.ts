import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolchainInfo,
  PackageManagerInfo,
  FrameworkInfo,
  RepoCommands,
} from '../types.js';
import { parseXmlProperties } from '../parser-utils.js';

export interface JvmDetectionResult {
  detected: boolean;
  ecosystems: string[];
  toolchains: ToolchainInfo[];
  packageManagers: PackageManagerInfo[];
  frameworks: FrameworkInfo[];
  commands: RepoCommands;
  manifests: string[];
}

export function detectJvm(workspaceRoot: string): JvmDetectionResult {
  const result: JvmDetectionResult = {
    detected: false,
    ecosystems: [],
    toolchains: [],
    packageManagers: [],
    frameworks: [],
    commands: {},
    manifests: [],
  };

  const pomPath = join(workspaceRoot, 'pom.xml');
  const gradlePath = join(workspaceRoot, 'build.gradle');
  const gradleKtsPath = join(workspaceRoot, 'build.gradle.kts');
  const javaVersionPath = join(workspaceRoot, '.java-version');

  const hasPom = existsSync(pomPath);
  const hasGradle = existsSync(gradlePath);
  const hasGradleKts = existsSync(gradleKtsPath);
  const hasJavaVersion = existsSync(javaVersionPath);

  if (!hasPom && !hasGradle && !hasGradleKts && !hasJavaVersion) {
    return result;
  }

  result.detected = true;
  result.ecosystems.push('java');

  let javaVersion: string | undefined;
  let javaSource: string | undefined;

  if (hasJavaVersion) {
    result.manifests.push('.java-version');
    try {
      javaVersion = readFileSync(javaVersionPath, 'utf-8').trim();
      javaSource = '.java-version';
    } catch {
      // ignore
    }
  }

  // Check Maven
  if (hasPom) {
    result.manifests.push('pom.xml');
    const hasMvnw = existsSync(join(workspaceRoot, 'mvnw'));
    if (hasMvnw) result.manifests.push('mvnw');

    let pomContent = '';
    try {
      pomContent = readFileSync(pomPath, 'utf-8');
    } catch {
      // ignore
    }

    const xmlProps = parseXmlProperties(pomContent);
    if (!javaVersion) {
      if (xmlProps['java.version']) {
        javaVersion = xmlProps['java.version'];
        javaSource = 'pom.xml#java.version';
      } else if (xmlProps['maven.compiler.source']) {
        javaVersion = xmlProps['maven.compiler.source'];
        javaSource = 'pom.xml#maven.compiler.source';
      } else if (xmlProps['maven.compiler.target']) {
        javaVersion = xmlProps['maven.compiler.target'];
        javaSource = 'pom.xml#maven.compiler.target';
      }
    }

    const mvnCmd = hasMvnw ? './mvnw' : 'mvn';

    result.packageManagers.push({
      name: 'maven',
      sourceFile: 'pom.xml',
    });

    if (pomContent.includes('junit-jupiter') || pomContent.includes('org.junit.jupiter')) {
      result.frameworks.push({ name: 'junit5', category: 'test', sourceFile: 'pom.xml' });
    } else if (pomContent.includes('junit') || pomContent.includes('org.junit')) {
      result.frameworks.push({ name: 'junit4', category: 'test', sourceFile: 'pom.xml' });
    }
    if (pomContent.includes('testng')) {
      result.frameworks.push({ name: 'testng', category: 'test', sourceFile: 'pom.xml' });
    }
    if (pomContent.includes('spring-boot')) {
      result.frameworks.push({ name: 'spring-boot', category: 'web', sourceFile: 'pom.xml' });
    }

    result.commands.install = `${mvnCmd} dependency:resolve`;
    result.commands.test = `${mvnCmd} test`;
    result.commands.build = `${mvnCmd} package -DskipTests`;
    result.commands.verify = `${mvnCmd} verify`;
  }

  // Check Gradle
  if (hasGradle || hasGradleKts) {
    const gradleFile = hasGradleKts ? 'build.gradle.kts' : 'build.gradle';
    result.manifests.push(gradleFile);

    const hasGradlew = existsSync(join(workspaceRoot, 'gradlew'));
    if (hasGradlew) result.manifests.push('gradlew');

    let gradleContent = '';
    try {
      gradleContent = readFileSync(join(workspaceRoot, gradleFile), 'utf-8');
    } catch {
      // ignore
    }

    if (hasGradleKts || gradleContent.includes('kotlin(') || gradleContent.includes('org.jetbrains.kotlin')) {
      result.ecosystems.push('kotlin');
    }

    if (!javaVersion) {
      const sourceCompMatch = gradleContent.match(/sourceCompatibility\s*=\s*['"]?([0-9.]+)['"]?/);
      if (sourceCompMatch) {
        javaVersion = sourceCompMatch[1];
        javaSource = `${gradleFile}#sourceCompatibility`;
      }
      const jvmTargetMatch = gradleContent.match(/jvmTarget\s*=\s*['"]?([0-9.]+)['"]?/);
      if (jvmTargetMatch) {
        javaVersion = jvmTargetMatch[1];
        javaSource = `${gradleFile}#jvmTarget`;
      }
    }

    const gradlewCmd = hasGradlew ? './gradlew' : 'gradle';

    result.packageManagers.push({
      name: 'gradle',
      sourceFile: gradleFile,
    });

    if (gradleContent.includes('junit') || gradleContent.includes('useJUnitPlatform')) {
      result.frameworks.push({ name: 'junit', category: 'test', sourceFile: gradleFile });
    }
    if (gradleContent.includes('kotest')) {
      result.frameworks.push({ name: 'kotest', category: 'test', sourceFile: gradleFile });
    }
    if (gradleContent.includes('spring-boot') || gradleContent.includes('org.springframework.boot')) {
      result.frameworks.push({ name: 'spring-boot', category: 'web', sourceFile: gradleFile });
    }

    if (!result.commands.test) {
      result.commands.install = `${gradlewCmd} dependencies`;
      result.commands.test = `${gradlewCmd} test`;
      result.commands.build = `${gradlewCmd} build`;
      result.commands.lint = `${gradlewCmd} check`;
    }
  }

  result.toolchains.push({
    name: 'java',
    version: javaVersion,
    rawSpec: javaVersion,
    sourceFile: javaSource,
  });

  return result;
}
