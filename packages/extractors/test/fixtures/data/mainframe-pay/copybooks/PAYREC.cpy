000100* PAYROLL MASTER RECORD                                           PAYREC01
000200 01  PAY-MASTER-REC.                                              PAYREC01
000300     05  EMP-ID              PIC X(8).                            PAYREC01
000400     05  EMP-NAME.                                                PAYREC01
000500         10  LAST-NAME       PIC X(20).                           PAYREC01
000600         10  FIRST-NAME      PIC X(15).                           PAYREC01
000700     05  GROSS-PAY           PIC S9(7)V99 COMP-3.                 PAYREC01
000800     05  PAY-STATUS          PIC X.                               PAYREC01
000900         88  PAY-ACTIVE      VALUE 'A'.                           PAYREC01
001000     05  FILLER              PIC X(10).                           PAYREC01
001100     05  DEDUCTION-AMT       PIC S9(5)V99 COMP-3 OCCURS 5 TIMES.  PAYREC01
