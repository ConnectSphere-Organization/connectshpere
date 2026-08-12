"use client";

import React, { useMemo } from 'react';
import { ExternalLink, Phone, FileText, Image as ImageIcon, Video, MoreHorizontal, Check, CheckCheck } from 'lucide-react';

interface WhatsAppBubbleProps {
  template: any;
  variableMapping?: Record<string, string>;
  mediaUrl?: string;
}

export function WhatsAppBubble({ template, variableMapping = {}, mediaUrl }: WhatsAppBubbleProps) {
  const renderFormattedText = (text: string) => {
    if (!text) return null;
    const parts = text.split(/(\{\{\d+\}\})/g);
    return parts.map((part, index) => {
      const match = part.match(/^\{\{(\d+)\}\}$/);
      if (match) {
        const num = match[1];
        const mapped = variableMapping[num];
        return mapped ? (
          <span key={index} className="bg-primary/20 text-primary px-1 rounded font-bold">
            {mapped}
          </span>
        ) : (
          part
        );
      }
      return part;
    });
  };

  const bodyContent = (() => {
    const text = template.bodyText || template.body?.text || '';
    return renderFormattedText(text);
  })();

  const headerContent = (() => {
    if (!template.header?.enabled || template.header?.format === 'NONE') return null;
    
    if (template.header.format === 'TEXT') {
      return (
        <div className="font-bold text-slate-900 dark:text-white mb-1">
          <div>{renderFormattedText(template.header.text || '')}</div>
        </div>
      );
    }

    const currentMediaUrl = mediaUrl || template.header.mediaUrl;

    if (template.header.format === 'IMAGE') {
      return (
        <div className="rounded-lg overflow-hidden mb-2 bg-slate-200 dark:bg-slate-800 flex items-center justify-center min-h-[150px] relative group">
          {currentMediaUrl ? (
            <img src={currentMediaUrl} alt="Header" className="w-full h-full object-cover" />
          ) : (
            <ImageIcon className="h-10 w-10 text-slate-400 opacity-50" />
          )}
        </div>
      );
    }

    if (template.header.format === 'VIDEO') {
      return (
        <div className="rounded-lg overflow-hidden mb-2 bg-slate-200 dark:bg-slate-800 flex items-center justify-center min-h-[150px]">
           <Video className="h-10 w-10 text-slate-400 opacity-50" />
        </div>
      );
    }

    if (template.header.format === 'DOCUMENT') {
      return (
        <div className="rounded-lg overflow-hidden mb-2 bg-slate-100 dark:bg-slate-800 p-3 flex items-center gap-3 border border-slate-200 dark:border-slate-700">
           <div className="bg-blue-500 p-2 rounded-lg text-white">
             <FileText className="h-5 w-5" />
           </div>
           <div className="flex-1 overflow-hidden">
             <p className="text-xs font-bold truncate">Document Name</p>
             <p className="text-[10px] text-slate-400">PDF • 1.2 MB</p>
           </div>
        </div>
      );
    }

    return null;
  })();

  return (
    <div className="flex flex-col max-w-full sm:max-w-[92%] mx-auto md:mx-0">
      <div className="relative bg-white dark:bg-[#1f2c33] p-1 rounded-2xl rounded-tl-none shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] dark:shadow-none border-none">
        {/* Triangle Tail */}
        <div className="absolute top-0 -left-1.5 w-0 h-0 border-t-[8px] border-t-white dark:border-t-[#1f2c33] border-l-[8px] border-l-transparent" />
        
        <div className="p-1.5 space-y-1">
          {headerContent}
          
          <div 
            className="text-[14.5px] leading-[1.45] text-[#111b21] dark:text-[#e9edef] whitespace-pre-wrap font-normal selection:bg-primary/30"
            style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}
          >
            {bodyContent}
          </div>
          
          <div className="flex items-center justify-end gap-1 mt-0.5">
            {template.footer?.enabled && template.footer.text && (
              <div className="text-[11px] text-[#667781] dark:text-[#8696a0] mr-auto italic opacity-80">
                {template.footer.text}
              </div>
            )}
            <span className="text-[10px] text-[#667781] dark:text-[#8696a0] font-medium uppercase tracking-tighter">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <CheckCheck className="h-3.5 w-3.5 text-[#53bdeb] opacity-80" />
          </div>
        </div>
      </div>

      {/* iOS Style Action Buttons */}
      {template.buttons?.enabled && template.buttons?.items?.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {template.buttons.items.map((btn: any, idx: number) => (
            <div 
              key={idx}
              className="bg-white dark:bg-[#1f2c33] py-3 px-4 rounded-xl shadow-sm flex items-center justify-center gap-2.5 text-[14px] font-semibold text-[#007aff] dark:text-[#53bdeb] hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-all active:scale-[0.98] border-none"
            >
              {btn.type === 'URL' && <ExternalLink className="h-4 w-4 opacity-70" />}
              {btn.type === 'PHONE_NUMBER' && <Phone className="h-4 w-4 opacity-70" />}
              {btn.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
