"use client";

import { CssBaseline, ThemeProvider as MuiThemeProvider, alpha, createTheme } from "@mui/material";
import { ReactNode, useMemo } from "react";

export default function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: "light",
          primary: { main: "#315da8" },
          secondary: { main: "#006c4c" },
          background: { default: "#f5f7fb", paper: "#ffffff" },
        },
        shape: { borderRadius: 12 },
        typography: { fontFamily: "Inter, system-ui, -apple-system, sans-serif", h4: { fontWeight: 700 }, h5: { fontWeight: 700 } },
        components: {
          MuiButton: {
            defaultProps: { disableElevation: true },
            styleOverrides: {
              root: ({ theme }) => ({
                textTransform: "none",
                fontWeight: 650,
                borderRadius: 14,
                transition: theme.transitions.create(["transform", "box-shadow", "background-color"], {
                  duration: theme.transitions.duration.shorter,
                }),
                "&.MuiButton-text": {
                  backgroundColor: theme.palette.background.paper,
                  border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
                  boxShadow: `0 5px 16px ${alpha(theme.palette.common.black, 0.07)}`,
                },
                "&.MuiButton-outlined": {
                  backgroundColor: theme.palette.background.paper,
                  boxShadow: `0 5px 16px ${alpha(theme.palette.common.black, 0.06)}`,
                },
                "&.MuiButton-contained": {
                  boxShadow: `0 7px 18px ${alpha(theme.palette.primary.main, 0.22)}`,
                },
                "&:hover": {
                  transform: "translateY(-1px) scale(1.045)",
                  boxShadow: `0 11px 25px ${alpha(theme.palette.common.black, 0.15)}`,
                },
                "&:active": { transform: "scale(0.98)" },
                "&.Mui-focusVisible": {
                  outline: `3px solid ${alpha(theme.palette.primary.main, 0.28)}`,
                  outlineOffset: 2,
                },
                "&.Mui-disabled": { transform: "none", boxShadow: "none" },
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                  "&:hover, &:active": { transform: "none" },
                },
              }),
            },
          },
          MuiIconButton: {
            styleOverrides: {
              root: ({ theme }) => ({
                backgroundColor: theme.palette.background.paper,
                border: `1px solid ${alpha(theme.palette.text.primary, 0.09)}`,
                borderRadius: 12,
                boxShadow: `0 5px 16px ${alpha(theme.palette.common.black, 0.08)}`,
                transition: theme.transitions.create(["transform", "box-shadow", "background-color"], {
                  duration: theme.transitions.duration.shorter,
                }),
                "&:hover": {
                  backgroundColor: alpha(theme.palette.primary.main, 0.08),
                  transform: "translateY(-1px) scale(1.08)",
                  boxShadow: `0 10px 22px ${alpha(theme.palette.common.black, 0.16)}`,
                },
                "&:active": { transform: "scale(0.96)" },
                "&.Mui-focusVisible": {
                  outline: `3px solid ${alpha(theme.palette.primary.main, 0.28)}`,
                  outlineOffset: 2,
                },
                "&.Mui-disabled": { transform: "none", boxShadow: "none" },
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                  "&:hover, &:active": { transform: "none" },
                },
              }),
            },
          },
          MuiAlert: {
            styleOverrides: {
              root: ({ theme, ownerState }) => ownerState.severity === "error" ? {
                border: `2px solid ${theme.palette.error.main}`,
                boxShadow: `0 10px 28px ${alpha(theme.palette.error.main, 0.22)}`,
                fontWeight: 700,
              } : {},
            },
          },
          MuiCard: { styleOverrides: { root: { border: "1px solid #e2e8f0", boxShadow: "0 8px 30px rgba(31, 41, 55, 0.05)" } } },
        },
      }),
    [],
  );
  return <MuiThemeProvider theme={theme}><CssBaseline />{children}</MuiThemeProvider>;
}
