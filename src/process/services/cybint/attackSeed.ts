/**
 * Minimal MITRE ATT&CK Enterprise technique seed — Theme 7.1.
 *
 * Covers the ~60 highest-frequency techniques across all 14 tactics, per
 * MITRE's own "top techniques" analyses. Deployers can extend the
 * attack_techniques table via direct DB insert without a migration.
 *
 * Source: https://attack.mitre.org (tactic + technique IDs are canonical).
 */
export interface AttackTechniqueSeed {
  id: string
  name: string
  tactic: string // kebab-case, e.g. "initial-access"
  description?: string
  parent_id?: string
}

export const ATTACK_TECHNIQUE_SEED: AttackTechniqueSeed[] = [
  // Initial Access (TA0001)
  { id: 'T1566', name: 'Phishing', tactic: 'initial-access' },
  { id: 'T1566.001', name: 'Spearphishing Attachment', tactic: 'initial-access', parent_id: 'T1566' },
  { id: 'T1566.002', name: 'Spearphishing Link', tactic: 'initial-access', parent_id: 'T1566' },
  { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access' },
  { id: 'T1133', name: 'External Remote Services', tactic: 'initial-access' },
  { id: 'T1195', name: 'Supply Chain Compromise', tactic: 'initial-access' },
  { id: 'T1078', name: 'Valid Accounts', tactic: 'initial-access' },
  { id: 'T1199', name: 'Trusted Relationship', tactic: 'initial-access' },

  // Execution (TA0002)
  { id: 'T1059', name: 'Command and Scripting Interpreter', tactic: 'execution' },
  { id: 'T1059.001', name: 'PowerShell', tactic: 'execution', parent_id: 'T1059' },
  { id: 'T1059.003', name: 'Windows Command Shell', tactic: 'execution', parent_id: 'T1059' },
  { id: 'T1059.004', name: 'Unix Shell', tactic: 'execution', parent_id: 'T1059' },
  { id: 'T1059.005', name: 'Visual Basic', tactic: 'execution', parent_id: 'T1059' },
  { id: 'T1204', name: 'User Execution', tactic: 'execution' },
  { id: 'T1204.002', name: 'Malicious File', tactic: 'execution', parent_id: 'T1204' },

  // Persistence (TA0003)
  { id: 'T1053', name: 'Scheduled Task/Job', tactic: 'persistence' },
  { id: 'T1053.005', name: 'Scheduled Task', tactic: 'persistence', parent_id: 'T1053' },
  { id: 'T1547', name: 'Boot or Logon Autostart Execution', tactic: 'persistence' },
  { id: 'T1547.001', name: 'Registry Run Keys / Startup Folder', tactic: 'persistence', parent_id: 'T1547' },
  { id: 'T1136', name: 'Create Account', tactic: 'persistence' },

  // Privilege Escalation (TA0004)
  { id: 'T1068', name: 'Exploitation for Privilege Escalation', tactic: 'privilege-escalation' },
  { id: 'T1548', name: 'Abuse Elevation Control Mechanism', tactic: 'privilege-escalation' },

  // Defense Evasion (TA0005)
  { id: 'T1027', name: 'Obfuscated Files or Information', tactic: 'defense-evasion' },
  { id: 'T1036', name: 'Masquerading', tactic: 'defense-evasion' },
  { id: 'T1070', name: 'Indicator Removal', tactic: 'defense-evasion' },
  { id: 'T1112', name: 'Modify Registry', tactic: 'defense-evasion' },
  { id: 'T1562', name: 'Impair Defenses', tactic: 'defense-evasion' },
  { id: 'T1562.001', name: 'Disable or Modify Tools', tactic: 'defense-evasion', parent_id: 'T1562' },
  { id: 'T1140', name: 'Deobfuscate/Decode Files or Information', tactic: 'defense-evasion' },

  // Credential Access (TA0006)
  { id: 'T1003', name: 'OS Credential Dumping', tactic: 'credential-access' },
  { id: 'T1003.001', name: 'LSASS Memory', tactic: 'credential-access', parent_id: 'T1003' },
  { id: 'T1110', name: 'Brute Force', tactic: 'credential-access' },
  { id: 'T1110.003', name: 'Password Spraying', tactic: 'credential-access', parent_id: 'T1110' },
  { id: 'T1555', name: 'Credentials from Password Stores', tactic: 'credential-access' },

  // Discovery (TA0007)
  { id: 'T1082', name: 'System Information Discovery', tactic: 'discovery' },
  { id: 'T1083', name: 'File and Directory Discovery', tactic: 'discovery' },
  { id: 'T1087', name: 'Account Discovery', tactic: 'discovery' },
  { id: 'T1016', name: 'System Network Configuration Discovery', tactic: 'discovery' },
  { id: 'T1057', name: 'Process Discovery', tactic: 'discovery' },

  // Lateral Movement (TA0008)
  { id: 'T1021', name: 'Remote Services', tactic: 'lateral-movement' },
  { id: 'T1021.001', name: 'Remote Desktop Protocol', tactic: 'lateral-movement', parent_id: 'T1021' },
  { id: 'T1021.002', name: 'SMB/Windows Admin Shares', tactic: 'lateral-movement', parent_id: 'T1021' },
  { id: 'T1570', name: 'Lateral Tool Transfer', tactic: 'lateral-movement' },

  // Collection (TA0009)
  { id: 'T1005', name: 'Data from Local System', tactic: 'collection' },
  { id: 'T1056', name: 'Input Capture', tactic: 'collection' },
  { id: 'T1113', name: 'Screen Capture', tactic: 'collection' },
  { id: 'T1560', name: 'Archive Collected Data', tactic: 'collection' },

  // Command and Control (TA0011)
  { id: 'T1071', name: 'Application Layer Protocol', tactic: 'command-and-control' },
  { id: 'T1071.001', name: 'Web Protocols', tactic: 'command-and-control', parent_id: 'T1071' },
  { id: 'T1105', name: 'Ingress Tool Transfer', tactic: 'command-and-control' },
  { id: 'T1572', name: 'Protocol Tunneling', tactic: 'command-and-control' },
  { id: 'T1090', name: 'Proxy', tactic: 'command-and-control' },
  { id: 'T1568', name: 'Dynamic Resolution', tactic: 'command-and-control' },

  // Exfiltration (TA0010)
  { id: 'T1041', name: 'Exfiltration Over C2 Channel', tactic: 'exfiltration' },
  { id: 'T1567', name: 'Exfiltration Over Web Service', tactic: 'exfiltration' },
  { id: 'T1048', name: 'Exfiltration Over Alternative Protocol', tactic: 'exfiltration' },

  // Impact (TA0040)
  { id: 'T1486', name: 'Data Encrypted for Impact', tactic: 'impact' },
  { id: 'T1485', name: 'Data Destruction', tactic: 'impact' },
  { id: 'T1490', name: 'Inhibit System Recovery', tactic: 'impact' },
  { id: 'T1498', name: 'Network Denial of Service', tactic: 'impact' },
  { id: 'T1489', name: 'Service Stop', tactic: 'impact' }
]

export const ATTACK_TACTICS: Array<{ id: string; name: string }> = [
  { id: 'reconnaissance', name: 'Reconnaissance' },
  { id: 'resource-development', name: 'Resource Development' },
  { id: 'initial-access', name: 'Initial Access' },
  { id: 'execution', name: 'Execution' },
  { id: 'persistence', name: 'Persistence' },
  { id: 'privilege-escalation', name: 'Privilege Escalation' },
  { id: 'defense-evasion', name: 'Defense Evasion' },
  { id: 'credential-access', name: 'Credential Access' },
  { id: 'discovery', name: 'Discovery' },
  { id: 'lateral-movement', name: 'Lateral Movement' },
  { id: 'collection', name: 'Collection' },
  { id: 'command-and-control', name: 'Command and Control' },
  { id: 'exfiltration', name: 'Exfiltration' },
  { id: 'impact', name: 'Impact' }
]
